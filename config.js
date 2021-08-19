if (!process.env.ES_HOST || !process.env.ES_AUTH) {
	throw new Error('You need to specify ES_HOST and ES_AUTH env variables.');
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
	host: process.env.ES_HOST,
	httpAuth: process.env.ES_AUTH
};

module.exports = {
	elasticsearch,
	githubAuth,
	repos,
	privateRepos,
};
