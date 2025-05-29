if (!process.env.ES_HOST || !process.env.ES_USER || !process.env.ES_PASSWORD) {
	throw new Error('You need to specify ES_HOST, ES_USER and ES_PASSWORD env variables.');
}

const repos = (process.env.REPOSITORIES || '').split(',').filter(val => Boolean(val));
const privateRepos = (process.env.PRIVATE_REPOS || '').split(',').filter(val => Boolean(val));

let githubAuth;

if (process.env.GITHUB_OAUTH_APP_ID && process.env.GITHUB_OAUTH_PRIVATE_KEY && process.env.GITHUB_OAUTH_INSTALLATION_ID) {
	console.log('Using GitHub OAuth app authentication');
	githubAuth = {
		appId: process.env.GITHUB_OAUTH_APP_ID,
		privateKey: process.env.GITHUB_OAUTH_PRIVATE_KEY,
		installationId: process.env.GITHUB_OAUTH_INSTALLATION_ID,
	};
} else if (process.env.GITHUB_TOKEN) {
	console.log('Using GitHub API token authentication');
	githubAuth = process.env.GITHUB_TOKEN;
} else {
	throw new Error('GitHub authentication required. Either provide GITHUB_TOKEN or all of GITHUB_OAUTH_APP_ID, GITHUB_OAUTH_PRIVATE_KEY, and GITHUB_OAUTH_INSTALLATION_ID.');
}

const elasticsearch = {
	node: process.env.ES_HOST,
	auth: {
		username: process.env.ES_USER,
		password: process.env.ES_PASSWORD,
	},
};

module.exports = {
	elasticsearch,
	githubAuth,
	repos,
	privateRepos,
};
