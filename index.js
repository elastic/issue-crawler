const config = require('./config.js');

const { Octokit } = require('@octokit/rest');
const { retry } = require('@octokit/plugin-retry');
const elasticsearch = require('elasticsearch');
const moment = require('moment');

const CACHE_INDEX = 'cache';

const client = new elasticsearch.Client(config.elasticsearch);

const RetryOctokit = Octokit.plugin(retry);
const octokit = new RetryOctokit({
	previews: ['squirrel-girl-preview'],
	auth: config.githubAuth,
	request: { retries: 2 }
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
		{ index: { _index: index, _type: '_doc', _id: issue.id }},
		issue
	]));
}

/**
 * Returns the bulk request body to update the cache key for the specified repo
 * and page.
 */
function getCacheKeyUpdate(owner, repo, page, key) {
	const id = `${owner}_${repo}_${page}`
	return [
		{ index: { _index: CACHE_INDEX, _type: '_doc', _id: id }},
		{ owner, repo, page, key }
	];
}

/**
 * Processes a GitHub response for the specified page of issues.
 * This will convert all issues to the desired format, store them into
 * Elasticsearch and update the cache key, we got from GitHub.
 */
async function processGitHubIssues(owner, repo, response, page, indexName, logDisplayName) {
	console.log(`[${logDisplayName}#${page}] Found ${response.data.length} issues`);
	if (response.data.length > 0) {
		const issues = response.data.map(issue => convertIssue(owner, repo, issue));
		const bulkIssues = getIssueBulkUpdates(indexName, issues);
		const updateCacheKey = getCacheKeyUpdate(owner, repo, page, response.headers.etag);
		const body = [...bulkIssues, ...updateCacheKey];
		console.log(`[${logDisplayName}#${page}] Writing issues and new cache key "${response.headers.etag}" to Elasticsearch`);
		await client.bulk({ body });
	}
}

/**
 * Load the existing cache for the specified repository. The result will be
 * in the format { [pageNr]: 'cacheKey' }.
 */
async function loadCacheForRepo(owner, repo) {
	const entries = await client.search({
		index: CACHE_INDEX,
		_source: ['page', 'key'],
		size: 10000,
		body: {
			query: {
				bool: {
					filter: [
						{ match: { owner } },
						{ match: { repo } }
					]
				}
			}
		}
	});

	if (entries.hits.total === 0) {
		return {};
	}

	return entries.hits.hits.reduce((cache, entry) => {
		cache[entry._source.page] = entry._source.key;
		return cache;
	}, {});
}

async function main() {
	async function handleRepository(repository, displayName = repository, isPrivate = false) {
		console.log(`Processing repository ${displayName}`);
		const [ owner, repo ] = repository.split('/');

		const cache = await loadCacheForRepo(owner, repo);

		let page = 1;
		let shouldCheckNextPage = true;
		while(shouldCheckNextPage) {
			console.log(`[${displayName}#${page}] Requesting issues using etag: ${cache[page]}`);
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
					headers: headers
				});
				console.log(`[${displayName}#${page}] Remaining request limit: %s/%s`,
					response.headers['x-ratelimit-remaining'],
					response.headers['x-ratelimit-limit']
				);
				const indexName = isPrivate ? `private-issues-${owner}-${repo}` : `issues-${owner}-${repo}`;
				await processGitHubIssues(owner, repo, response, page, indexName, displayName);
				shouldCheckNextPage = response.headers.link && response.headers.link.includes('rel="next"');
				page++;
			} catch (error) {
				if (error.name === 'HttpError' && error.status === 304) {
					// Ignore not modified responses and continue with the next page.
					console.log(`[${displayName}#${page}] Page was not modified. Continue with next page.`);
					page++;
					continue;
				}

				if(error.request && error.request.request.retryCount) {
					console.error(`[${displayName}#${page}] Failed request for page after ${error.request.request.retryCount} retries.`);
					console.error(`[${displayName}#${page}] ${error.toString()}`);
				} else {
					console.error(error);
				}
				throw error;
			}
		}
	}

	const results = await Promise.allSettled([
		...config.repos.map(rep => handleRepository(rep)),
		...(config.privateRepos.length > 0 ? config.privateRepos.map((rep, index) => handleRepository(rep, `PRIVATE_REPOS[${index}]`, true)) : [])
	]);

	if (results.some(({ status }) => status === 'rejected')) {
		process.exit(1);
	}
}

main();
