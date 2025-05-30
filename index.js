import config from './config.js';

import {Octokit} from '@octokit/rest';
import {createAppAuth} from '@octokit/auth-app';
import {retry} from '@octokit/plugin-retry';
import {throttling} from '@octokit/plugin-throttling';
import {Client} from '@elastic/elasticsearch';
import moment from 'moment';

const CACHE_INDEX = 'crawler-cache';

const client = new Client({...config.elasticsearch, compression: 'gzip'});

const RetryOctokit = Octokit.plugin(retry, throttling);
const octokit = new RetryOctokit({
    previews: ['squirrel-girl-preview'],
    ...(typeof config.githubAuth === 'object' ? { authStrategy: createAppAuth, auth: config.githubAuth } : { auth: config.githubAuth }),
    throttle: {
        onRateLimit: (retryAfter, options, octokit) => {
            octokit.log.warn(`Request quota exhausted.`);
        },
        onSecondaryRateLimit: (retryAfter, options, octokit) => {
            octokit.log.warn(`Secondary quota detected for request ${options.method} ${options.url}`)
        }
    },
    retry: {
        doNotRetry: ['429'],
    },
});

/**
 * Enhace a passed in date, into an object that contains further useful
 * information about that date (e.g. day of the week or hour of day).
 */
function enhanceDate(date) {
    if (!date) return null;

    const m = moment(date);
    return {
        time: m.format(),
        weekday: m.format('ddd'),
        weekday_number: parseInt(m.format('d')),
        hour_of_day: parseInt(m.format('H'))
    };
}

/**
 * Takes in the raw issue from the GitHub API response and must return the
 * object that should be stored inside Elasticsearch.
 */
function convertIssue(owner, repo, raw) {
    const time_to_fix = (raw.created_at && raw.closed_at) ?
        moment(raw.closed_at).diff(moment(raw.created_at)) :
        null;
    return {
        id: raw.id,
        last_crawled_at: Date.now(),
        owner: owner,
        repo: repo,
        state: raw.state,
        title: raw.title,
        number: raw.number,
        url: raw.url,
        locked: raw.locked,
        comments: raw.comments,
        created_at: enhanceDate(raw.created_at),
        updated_at: enhanceDate(raw.updated_at),
        closed_at: enhanceDate(raw.closed_at),
        author_association: raw.author_association,
        user: raw.user.login,
        body: raw.body,
        labels: raw.labels.map(label => label.name),
        is_pullrequest: !!raw.pull_request,
        assignees: !raw.assignees ? null : raw.assignees.map(a => a.login),
        reactions: !raw.reactions ? null : {
            total: raw.reactions.total_count,
            upVote: raw.reactions['+1'],
            downVote: raw.reactions['-1'],
            laugh: raw.reactions.laugh,
            hooray: raw.reactions.hooray,
            confused: raw.reactions.confused,
            heart: raw.reactions.hearts,
            rocket: raw.reactions.rocket,
            eyes: raw.reactions.eyes,
        },
        time_to_fix: time_to_fix,
    };
}

/**
 * Create a bulk request body for all issues. You need to specify the index in
 * which these issues should be stored.
 */
function getIssueBulkUpdates(index, issues) {
    return [].concat(...issues.map(issue => [
        {index: {_index: index, _id: issue.id}},
        issue
    ]));
}

/**
 * Returns the bulk request body to update the timestamp cache for the specified repo.
 */
function getTimestampCacheUpdate(owner, repo, timestamp) {
    const id = `${owner}_${repo}`
    return [
        {index: {_index: CACHE_INDEX, _id: id}},
        {owner, repo, timestamp}
    ];
}

/**
 * Processes a GitHub response for the specified page of issues.
 * This will convert all issues to the desired format and store them into
 * Elasticsearch.
 */
async function processGitHubIssues(owner, repo, response, page, indexName, logDisplayName) {
    console.log(`[${logDisplayName}#${page}] Found ${response.data.length} issues`);
    if (response.data.length > 0) {
        const issues = response.data.map(issue => convertIssue(owner, repo, issue));
        const bulkIssues = getIssueBulkUpdates(indexName, issues);
        const body = [...bulkIssues];
        console.log(`[${logDisplayName}#${page}] Writing ${issues.length} issues to Elasticsearch`);
        const esResult = await client.bulk({body});

        if (esResult.errors) {
            const errorItems = esResult.items.filter(x => x.index.error != null);
            console.warn(`[${logDisplayName}#${page}] [ERROR] ${JSON.stringify(errorItems, null, 2)}`);
        }
    }
}

/**
 * Returns the timestamp of the last fetch for a given repo or null if not found.
 */
async function loadCacheForRepo(owner, repo) {
    try {
        const body = await client.search({
            index: CACHE_INDEX,
            _source: ['timestamp'],
            size: 1,
            body: {
                query: {
                    bool: {
                        filter: [
                            {match: {owner}},
                            {match: {repo}},
                            {exists: {field: "timestamp"}}
                        ]
                    }
                }
            }
        });

        if (body.hits.hits.length > 0) {
            return body.hits.hits[0]._source.timestamp;
        }
        return null;
    } catch (error) {
        console.error(`Failed to load cache for ${owner}/${repo}:`, error);
        return null;
    }
}

/**
 * Cleans up any stale open issues that might have been transferred.
 * Checks older open issues in Elasticsearch and deletes them
 * if they no longer exist in GitHub (i.e., return 301).
 */
async function cleanupTransferredIssues(owner, repo, isPrivate = false) {
    const indexName = isPrivate ? `private-issues-${owner}-${repo}` : `issues-${owner}-${repo}`;
    console.log(`[CLEANUP] Searching for stale open issues in ${indexName}`);
    const esSearch = await client.search({
    index: indexName,
        size: 2000,
        body: {
            query: {
                bool: {
                    must: [{ term: { state: 'open' } }],
                    filter: [
                        {
                            range: {
                                'updated_at.time': {
                                    lt: 'now-60d'
                                }
                            }
                        }
                    ]
                }
            }
        }
    });

    const hits = esSearch.body.hits.hits;
    console.log(`[CLEANUP] Found ${hits.length} stale open issues in ${owner}/${repo} to verify.`);
    for (const doc of hits) {
        const issueData = doc._source;
        const issueNumber = issueData.number;
        const docId = doc._id;
        let stillExists = true;
        try {
            await octokit.issues.get({ owner, repo, issue_number: issueNumber });
        } catch (err) {
            if (err.status === 301) {
                stillExists = false;
            } else {
                console.error(`[CLEANUP] Error verifying #${issueNumber}:`, err);
            }
        }
        if (!stillExists) {
            console.log(`[CLEANUP] Issue #${issueNumber} was moved; deleting from Elasticsearch`);
            await client.delete({
                index: indexName,
                id: docId
            });
        }
    }
    console.log(`[CLEANUP] Completed cleanup for ${owner}/${repo}`);
}

async function main() {
    try {
        async function handleRepository(repository, displayName = repository, isPrivate = false) {
            console.log(`[${displayName}] Processing repository ${displayName}`);
            const [owner, repo] = repository.split('/');

            const lastFetchTimestamp = await loadCacheForRepo(owner, repo);
            console.log(`[${displayName}] Last fetch timestamp: ${lastFetchTimestamp || 'none'}`);            
            const currentTimestamp = new Date().toISOString();

            let page = 1;
            let shouldCheckNextPage = true;
            let url = "/repos/{owner}/{repo}/issues";
            while (shouldCheckNextPage) {
                console.log(`[${displayName}#${page}] Requesting issues using since: ${lastFetchTimestamp || 'none'}`);
                try {
                    const options = {
                        url,
                        owner,
                        repo,
                        per_page: 100,
                        state: 'all',
                        sort: 'created',
                        direction: 'asc'
                    };
                    if (lastFetchTimestamp) {
                        options.since = lastFetchTimestamp;
                    }
                    
                    const response = await octokit.issues.listForRepo(options);
                    console.log(`[${displayName}#${page}] Remaining request limit: %s/%s`,
                        response.headers['x-ratelimit-remaining'],
                        response.headers['x-ratelimit-limit']
                    );
                    const indexName = isPrivate ? `private-issues-${owner}-${repo}` : `issues-${owner}-${repo}`;
                    url = ((response.headers.link || "").match(
                        /<([^<>]+)>;\s*rel="next"/
                    ) || [])[1];
                    await processGitHubIssues(owner, repo, response, page, indexName, displayName);

                    shouldCheckNextPage = response.headers.link && response.headers.link.includes('rel="next"');
                    page++;
                } catch (error) {

                    if (error.request && error.request.request.retryCount) {
                        console.error(`[${displayName}#${page}] Failed request for page after ${error.request.request.retryCount} retries.`);
                        console.error(`[${displayName}#${page}] ${error.toString()}`);
                    } else {
                        console.error(error);
                    }
                    throw error;
                }
            }
            
            // After processing all pages, update the timestamp cache
            console.log(`[${displayName}] Updating timestamp cache to ${currentTimestamp}`);
            const updateTimestampCache = getTimestampCacheUpdate(owner, repo, currentTimestamp);
            await client.bulk({body: updateTimestampCache});
        }

        const results = await Promise.allSettled([
            ...config.repos.map(rep => handleRepository(rep)),
            ...(config.privateRepos.length > 0 ? config.privateRepos.map((rep, index) => handleRepository(rep, rep, true)) : [])
        ]);

        const failedRepos = results.filter(r => r.status === 'rejected');
        if (failedRepos.length > 0) {
            console.error(`${failedRepos.length} repositories failed to process`);
            failedRepos.forEach((result, i) => {
                console.error(`Failed repository #${i}:`, result.reason);
            });
            process.exit(1);
        } else {
            console.log('All repositories processed successfully!');
        }
    } catch (error) {
        console.error('Unexpected error in main execution:', error);
        process.exit(1);
    }
}

main().catch(error => {
    console.error('Failed to execute script:', error);
    process.exit(1);
});