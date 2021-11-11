if (!process.env.ES_HOST || !process.env.ES_USER || !process.env.ES_PASSWORD) {
	throw new Error('You need to specify ES_HOST, ES_USER and ES_PASSWORD env variables.');
}

if (!process.env.GITHUB_OAUTH_APP_ID || !process.env.GITHUB_OAUTH_PRIVATE_KEY || !process.env.GITHUB_OAUTH_INSTALLATION_ID) {
	throw new Error('You need to specify Github OAuth app information.');
}

const repos = (process.env.REPOSITORIES || '').split(',').filter(val => Boolean(val));
const privateRepos = (process.env.PRIVATE_REPOS || '').split(',').filter(val => Boolean(val));

const githubAuth = {
	appId: process.env.GITHUB_OAUTH_APP_ID,
	privateKey: process.env.GITHUB_OAUTH_PRIVATE_KEY,
	installationId: process.env.GITHUB_OAUTH_INSTALLATION_ID,
};

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
