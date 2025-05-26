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
	previews: ['squirrel-girl-preview', 'mockingbird-preview'],
	authStrategy: createAppAuth,
	auth: config.githubAuth,
	request: { retries: 2 },
	throttle: {
		onRateLimit: (retryAfter, options, octokit) => {
			octokit.log.warn('Request quota exhausted.');
		},
		onAbuseLimit: (retryAfter, options, octokit) => {
			octokit.log.warn(`Abuse limit triggered, retrying after ${retryAfter}s ...`);
			return true;
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
	const transferEvt = (raw.timeline || []).find(e => e.event === 'transferred');
	const is_transferred = !!transferEvt;
	const moved_from = transferEvt?.previous_repository?.full_name ?? null;
	const moved_to = transferEvt?.repository?.full_name ?? null;
	const transferred_at = transferEvt ? enhanceDate(transferEvt.created_at) : null;

	const time_to_fix = (raw.created_at && raw.closed_at)
		? moment(raw.closed_at).diff(moment(raw.created_at))
		: null;

	return {
		id: raw.id,
		last_crawled_at: Date.now(),
		owner,
		repo,
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
		assignees: raw.assignees?.map(a => a.login) ?? null,
		reactions: raw.reactions
			? {
				total: raw.reactions.total_count,
				upVote: raw.reactions['+1'],
				downVote: raw.reactions['-1'],
				laugh: raw.reactions.laugh,
				hooray: raw.reactions.hooray,
				confused: raw.reactions.confused,
				heart: raw.reactions.hearts,
				rocket: raw.reactions.rocket,
				eyes: raw.reactions.eyes,
			}
			: null,
		time_to_fix,
		is_transferred,
		moved_from,
		moved_to,
		transferred_at,
	};
}

/**
 * Create a bulk request body for all issues. You need to specify the index in
 * which these issues should be stored.
 */
function getIssueBulkUpdates(index, issues) {
	return [].concat(
		...issues.map(issue => [
			{ index: { _index: index, _id: issue.id } },
			issue,
		])
	);
}

/**
 * Returns the bulk request body to update the cache key for the specified repo
 * and page.
 */
function getCacheKeyUpdate(owner, repo, page, key) {
	const id = `${owner}_${repo}_${page}`;
	return [
		{ index: { _index: 'crawler-cache', _id: id } },
		{ owner, repo, page, key },
	];
}

/**
 * Processes a GitHub response for the specified page of issues.
 * This will convert all issues to the desired format, store them into
 * Elasticsearch and update the cache key, we got from GitHub.
 */
async function processGitHubIssues(owner, repo, response, page, indexName, logDisplayName) {
	console.log(`[${logDisplayName}#${page}] Found ${response.data.length} issues`);
	if (!response.data.length) return;

	const enriched = await Promise.all(
		response.data.map(async raw => {
			if (raw.state === 'open') {
				try {
					const tl = await octokit.issues.listEventsForTimeline({
						owner,
						repo,
						issue_number: raw.number,
					});
					raw.timeline = tl.data;
				} catch (err) {
					console.warn(`timeline fetch failed for #${raw.number}:`, err.message);
					raw.timeline = [];
				}
			} else {
				raw.timeline = [];
			}
			return raw;
		})
	);

	const issues = enriched.map(raw => convertIssue(owner, repo, raw));
	const bulkIssues = getIssueBulkUpdates(indexName, issues);
	const updateKey = getCacheKeyUpdate(owner, repo, page, response.headers.etag);
	const body = [...bulkIssues, ...updateKey];

	console.log(
		`[${logDisplayName}#${page}] Writing issues + cache key "${response.headers.etag}" to Elasticsearch`
	);
	const esResult = await getLazyClient().bulk({ body });
	if (esResult.body.errors) {
		console.warn(
			`[${logDisplayName}#${page}] [ERROR]`,
			JSON.stringify(esResult.body, null, 2)
		);
	}
	esResult.warnings?.forEach(w => console.warn(`[${logDisplayName}#${page}] [WARN]`, w));
}

/**
 * Load the existing cache for the specified repository. The result will be
 * in the format { [pageNr]: 'cacheKey' }.
 */
async function loadCacheForRepo(owner, repo) {
	const { body } = await getLazyClient().search({
		index: 'crawler-cache',
		_source: ['page', 'key'],
		size: 10000,
		body: {
			query: {
				bool: {
					filter: [
						{ match: { owner } },
						{ match: { repo } },
					],
				},
			},
		},
	});

	return body.hits.hits.reduce((cache, hit) => {
		cache[hit._source.page] = hit._source.key;
		return cache;
	}, {});
}

/**
 * Cleans up any stale open issues that might have been transferred out of
 * the original repo. Looks up issues older than 60 days and checks their
 * existence in GitHub; if not found, marks them as transferred in ES.
 */
async function cleanupTransferredIssues(owner, repo, isPrivate = false) {
	const indexName = isPrivate
		? `private-issues-${owner}-${repo}`
		: `issues-${owner}-${repo}`;

	const esClient = getLazyClient();
	console.log(`[CLEANUP] Searching for stale open issues in ${indexName}`);

	const { body: esSearch } = await esClient.search({
		index: indexName,
		size: 2000,
		body: {
			query: {
				bool: {
					must: [
						{ term: { state: 'open' } },
					],
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

	const hits = esSearch.hits.hits;
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
			await esClient.update({
				index: indexName,
				id: docId,
				body: {
					doc: {
						state: 'transferred',
						is_transferred: true,
					}
				}
			});
		}
	}

	console.log(`[CLEANUP] Completed cleanup for ${owner}/${repo}`);
}

async function main() {
	async function handleRepository(repository, displayName = repository, isPrivate = false) {
		console.log(`[${displayName}] Processing repository`);
		const [owner, repo] = repository.split('/');
		console.log(`[${displayName}] Loading cache entries...`);
		const cache = await loadCacheForRepo(owner, repo);
		console.log(`[${displayName}] Found ${Object.keys(cache).length} cache entries`);

		let page = 1;
		let hasNext = true;
		while (hasNext) {
			console.log(`[${displayName}#${page}] Requesting issues, ETag=${cache[page]}`);
			try {
				const headers = cache[page] ? { 'If-None-Match': cache[page] } : {};
				const response = await octokit.issues.listForRepo({
					owner,
					repo,
					page,
					per_page: 100,
					state: 'all',
					sort: 'created',
					direction: 'asc',
					headers,
				});

				console.log(
					`[${displayName}#${page}] Rate limit: ${response.headers['x-ratelimit-remaining']}/${response.headers['x-ratelimit-limit']}`
				);

				const indexName = isPrivate
					? `private-issues-${owner}-${repo}`
					: `issues-${owner}-${repo}`;

				await processGitHubIssues(owner, repo, response, page, indexName, displayName);
				hasNext = response.headers.link?.includes('rel="next"');
				page++;
			} catch (error) {
				if (error.name === 'HttpError' && error.status === 304) {
					console.log(`[${displayName}#${page}] Not modified; skipping.`);
					page++;
					continue;
				}
				console.error(error);
				throw error;
			}
		}
	}

	const all = [
		...config.repos.map(r => handleRepository(r)),
		...config.privateRepos.map((r, i) =>
			handleRepository(r, `PRIVATE_REPOS[${i}]`, true)
		),
	];

	const results = await Promise.allSettled(all);
	if (results.some(r => r.status === 'rejected')) {
		process.exit(1);
	}
}

main();

module.exports = {
	convertIssue,
	processGitHubIssues,
	cleanupTransferredIssues,
};
