const config = require('./config.js');
const { Octokit } = require('@octokit/rest');
const { createAppAuth } = require('@octokit/auth-app');
const { retry } = require('@octokit/plugin-retry');
const { throttling } = require('@octokit/plugin-throttling');
const { Client } = require('@elastic/elasticsearch');
const moment = require('moment');

const CACHE_INDEX = 'crawler-cache';

let lazyClient;
function getLazyClient() {
	if (!lazyClient) {
		lazyClient = new Client({ ...config.elasticsearch, compression: 'gzip' });
	}
	return lazyClient;
}

const RetryOctokit = Octokit.plugin(retry, throttling);
const octokit = new RetryOctokit({
	previews: ['squirrel-girl-preview'],
	...(typeof config.githubAuth === 'object' ? { authStrategy: createAppAuth, auth: config.githubAuth } : { auth: config.githubAuth }),
	throttle: {
		onRateLimit: (retryAfter, options, octokit) => {
			octokit.log.warn(`Request quota exhausted.`);
		},
		onAbuseLimit: (retryAfter, options, octokit) => {
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
		hour_of_day: parseInt(m.format('H')),
	};
}

/**
 * Takes in the raw issue from the GitHub API response and must return the
 * object that should be stored inside Elasticsearch.
 */
function convertIssue(owner, repo, raw) {
	const time_to_fix = (raw.created_at && raw.closed_at)
		? moment(raw.closed_at).diff(moment(raw.created_at))
		: null;

	const transferEvt = (raw.timeline || []).find(e => e.event === 'transferred');
	const is_transferred = !!transferEvt;
	const moved_from = transferEvt && transferEvt.previous_repository
		? transferEvt.previous_repository.full_name
		: null;
	const moved_to = transferEvt && transferEvt.repository
		? transferEvt.repository.full_name
		: null;
	const transferred_at = transferEvt ? enhanceDate(transferEvt.created_at) : null;

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

		is_transferred: is_transferred,
		moved_from: moved_from,
		moved_to: moved_to,
		transferred_at: transferred_at,
	};
}

/**
 * Create a bulk request body for all issues. You need to specify the index in
 * which these issues should be stored.
 */
function getIssueBulkUpdates(index, issues) {
	return [].concat(...issues.map(issue => [
		{ index: { _index: index, _id: issue.id } },
		issue
	]));
}

/**
 * Returns the bulk request body to update the timestamp cache for the specified repo.
 */
function getTimestampCacheUpdate(owner, repo, timestamp) {
	const id = `${owner}_${repo}`
	return [
		{ index: { _index: CACHE_INDEX, _id: id } },
		{ owner, repo, timestamp }
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
		const enriched = await Promise.all(
			response.data.map(async issue => {
				if (issue.state === 'open') {
					try {
						const tl = await octokit.issues.listEventsForTimeline({
							owner,
							repo,
							issue_number: issue.number,
						});
						issue.timeline = tl.data;
					} catch (err) {
						console.warn(
							`[${logDisplayName}#${page}] Failed to fetch timeline for issue #${issue.number}:`,
							err.message
						);
						issue.timeline = [];
					}
				} else {
					issue.timeline = [];
				}
				return issue;
			})
		);

		const issues = enriched.map(i => convertIssue(owner, repo, i));
		const bulkIssues = getIssueBulkUpdates(indexName, issues);
		console.log(`[${logDisplayName}#${page}] Writing ${issues.length} issues to Elasticsearch`);

		const body = [...bulkIssues];
		const esResult = await getLazyClient().bulk({ body });

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
		const body = await getLazyClient().search({
			index: CACHE_INDEX,
			_source: ['timestamp'],
			size: 1,
			body: {
				query: {
					bool: {
						filter: [
							{ match: { owner } },
							{ match: { repo } },
							{ exists: { field: 'timestamp' } },
						],
					},
				},
			},
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
 * Checks older open issues in Elasticsearch and marks them as transferred
 * if they no longer exist in GitHub.
 */
async function cleanupTransferredIssues(owner, repo, isPrivate = false) {
	const indexName = isPrivate
		? `private-issues-${owner}-${repo}`
		: `issues-${owner}-${repo}`;

	console.log(`[CLEANUP] Searching for stale open issues in ${indexName}`);
	const esSearch = await getLazyClient().search({
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
									lt: 'now-60d',
								},
							},
						},
					],
				},
			},
		},
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
			if (err.status === 404) {
				stillExists = false;
			} else {
				console.error(`[CLEANUP] Error verifying #${issueNumber}:`, err);
			}
		}

		if (!stillExists) {
			console.log(`[CLEANUP] Issue #${issueNumber} not found; marking as transferred in ES`);
			await getLazyClient().update({
				index: indexName,
				id: docId,
				body: {
					doc: {
						state: 'transferred',
						is_transferred: true,
					},
				},
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
					console.log(
						`[${displayName}#${page}] Remaining request limit: %s/%s`,
						response.headers['x-ratelimit-remaining'],
						response.headers['x-ratelimit-limit']
					);
					const indexName = isPrivate
						? `private-issues-${owner}-${repo}`
						: `issues-${owner}-${repo}`;
					url = ((response.headers.link || '').match(/<([^<>]+)>;\s*rel="next"/) || [])[1];

					await processGitHubIssues(owner, repo, response, page, indexName, displayName);

					shouldCheckNextPage =
						response.headers.link && response.headers.link.includes('rel="next"');
					page++;
				} catch (error) {
					if (error.request && error.request.request.retryCount) {
						console.error(
							`[${displayName}#${page}] Failed request for page after ${error.request.request.retryCount} retries.`
						);
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
			await getLazyClient().bulk({ body: updateTimestampCache });
		}

		// Process configured repos
		const results = await Promise.allSettled([
			...config.repos.map(rep => handleRepository(rep)),
			...(config.privateRepos.length > 0
				? config.privateRepos.map(rep => handleRepository(rep, rep, true))
				: []),
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

module.exports = {
	convertIssue,
	processGitHubIssues,
	cleanupTransferredIssues,
};
