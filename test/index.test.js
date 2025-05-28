jest.mock('@elastic/elasticsearch', () => {
    return { Client: jest.fn() };
});

jest.mock('@octokit/rest', () => {
    const real = jest.requireActual('@octokit/rest');
    const issuesGetMock = jest.fn();

    class MockOctokit extends real.Octokit {
        constructor(opts) {
            const merged = {
                ...opts,
                throttle: {
                    ...(opts.throttle || {}),
                    onRateLimit:
                        (opts.throttle && opts.throttle.onRateLimit) || jest.fn(),
                    onAbuseLimit:
                        (opts.throttle && opts.throttle.onAbuseLimit) || jest.fn(),
                },
            };
            super(merged);
            this.issues.get = issuesGetMock;
        }
    }
    MockOctokit.plugin = real.Octokit.plugin;

    return { Octokit: MockOctokit, _issuesGetMock: issuesGetMock };
});

const moment = require('moment');

let convertIssue;
let processGitHubIssues;
let cleanupTransferredIssues;
let clientMock;
let issuesGetMock;

describe('GitHub issue processing', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        const { Client } = require('@elastic/elasticsearch');
        const bulkMock = jest.fn().mockResolvedValue({ body: {} });
        const searchMock = jest.fn().mockResolvedValue({ body: {} });
        const updateMock = jest.fn().mockResolvedValue({ body: {} });

        Client.mockImplementation(() => ({
            bulk: bulkMock,
            search: searchMock,
            update: updateMock,
        }));

        clientMock = { bulk: bulkMock, search: searchMock, update: updateMock };

        const mod = require('../index.js');
        ({
            convertIssue,
            processGitHubIssues,
            cleanupTransferredIssues,
        } = mod);

        issuesGetMock = require('@octokit/rest')._issuesGetMock;
    });

    describe('convertIssue', () => {
        it('sets basic fields correctly', () => {
            const raw = {
                id: 12345,
                created_at: '2022-01-01T10:00:00Z',
                closed_at: null,
                state: 'open',
                title: 'Sample issue',
                number: 42,
                url: 'https://api.github.com/repos/owner/repo/issues/42',
                locked: false,
                comments: 10,
                user: { login: 'testUser' },
                author_association: 'OWNER',
                body: 'Test body',
                labels: [{ name: 'bug' }, { name: 'help wanted' }],
                assignees: [{ login: 'user1' }, { login: 'user2' }],
                pull_request: null,
                reactions: {
                    total_count: 5,
                    '+1': 3,
                    '-1': 0,
                    laugh: 2,
                    hooray: 0,
                    confused: 0,
                    heart: 0,
                    rocket: 0,
                    eyes: 0,
                },
            };

            const out = convertIssue('owner', 'repo', raw);

            expect(out.id).toBe(12345);
            expect(out.state).toBe('open');
            expect(out.owner).toBe('owner');
            expect(out.repo).toBe('repo');
            expect(out.title).toBe('Sample issue');
            expect(out.number).toBe(42);
            expect(out.user).toBe('testUser');
            expect(out.labels).toEqual(expect.arrayContaining(['bug']));
            expect(out.assignees).toEqual(['user1', 'user2']);
            expect(out.reactions.total).toBe(5);
            expect(out.time_to_fix).toBeNull();
            expect(moment(out.created_at.time).utc().format())
                .toBe('2022-01-01T10:00:00Z');
        });
    });

    describe('processGitHubIssues', () => {
        const owner = 'someOwner';
        const repo = 'someRepo';
        const page = 1;
        const indexName = 'issues-someOwner-someRepo';
        const logDisplayName = 'TEST_REPO';

        it('writes issues to Elasticsearch when issues exist', async () => {
            const fakeIssues = [
                {
                    id: 1, number: 101, state: 'open',
                    labels: [], user: { login: 'u1' }
                },
                {
                    id: 2, number: 202, state: 'closed',
                    labels: [], user: { login: 'u2' }
                },
            ];
            const resp = { data: fakeIssues, headers: { etag: '"abc"' } };

            await processGitHubIssues(
                owner, repo, resp, page, indexName, logDisplayName,
            );

            expect(clientMock.bulk).toHaveBeenCalledTimes(1);
            const bulkBody = clientMock.bulk.mock.calls[0][0].body;

            // two issues => four lines (action/meta + doc) …
            expect(bulkBody.length).toBe(4);
            expect(bulkBody[1].number).toBe(101);
            expect(bulkBody[3].number).toBe(202);
        });

        it('does nothing when no issues are returned', async () => {
            const resp = { data: [], headers: { etag: '"abc"' } };

            await processGitHubIssues(
                owner, repo, resp, page, indexName, logDisplayName,
            );

            expect(clientMock.bulk).not.toHaveBeenCalled();
        });
    });


    describe('cleanupTransferredIssues', () => {
        it('marks stale open issues as transferred if GitHub returns 301', async () => {
            clientMock.search.mockResolvedValue({
                body: {
                    hits: {
                        hits: [
                            {
                                _id: 'doc123',
                                _source: {
                                    number: 555,
                                    state: 'open',
                                    updated_at: { time: '2021-01-01T00:00:00Z' },
                                }
                            },
                        ],
                    },
                },
            });
            issuesGetMock.mockRejectedValue({ status: 301 });

            await cleanupTransferredIssues('someOwner', 'someRepo');

            expect(clientMock.update).toHaveBeenCalledTimes(1);
            expect(clientMock.update).toHaveBeenCalledWith({
                index: 'issues-someOwner-someRepo',
                id: 'doc123',
                body: {
                    doc: {
                        state: 'transferred',
                        is_transferred: true,
                    },
                },
            });
        });

        it('does not mark issue if status is not 301', async () => {
            clientMock.search.mockResolvedValue({
                body: {
                    hits: {
                        hits: [
                            {
                                _id: 'doc123',
                                _source: {
                                    number: 555,
                                    state: 'open',
                                    updated_at: { time: '2021-01-01T00:00:00Z' },
                                }
                            },
                        ]
                    },
                },
            });
            issuesGetMock.mockRejectedValue({ status: 403 });

            await cleanupTransferredIssues('someOwner', 'someRepo');

            expect(clientMock.update).not.toHaveBeenCalled();
        });
    });
});
