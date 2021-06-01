if (!process.env.GITHUB_OAUTH_TOKEN || !process.env.ES_HOST || !process.env.ES_AUTH) {
	throw new Error('You need to specify GITHUB_OAUTH_TOKEN, ES_HOST and ES_AUTH env variables.');
}

const repos = (process.env.REPOSITORIES || '').split(',').filter(val => Boolean(val));
const privateRepos = (process.env.PRIVATE_REPOS || '').split(',').filter(val => Boolean(val));

const githubAuth = process.env.GITHUB_OAUTH_TOKEN;

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
