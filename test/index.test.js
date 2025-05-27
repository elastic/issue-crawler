
// Tests for the GitHub issue crawler, mocking @elastic/elasticsearch and partially mocking @octokit/rest
// Validates convertIssue behavior and checks whether timeline calls happen only for open issues

jest.mock('@elastic/elasticsearch', () => {
  const bulkMock = jest.fn().mockResolvedValue({ body: {} });
  const searchMock = jest.fn().mockResolvedValue({ body: {} });
  return {
    Client: jest.fn().mockImplementation(() => ({
      bulk: bulkMock,
      search: searchMock,
    })),
  };
});

jest.mock('@octokit/rest', () => {
  const original = jest.requireActual('@octokit/rest');
  const listEventsForTimelineMock = jest.fn();

  class MockOctokit extends original.Octokit {
    constructor(options) {
      super(options);
      this.issues.listEventsForTimeline = listEventsForTimelineMock;
    }
  }
  MockOctokit.plugin = original.Octokit.plugin;

  return {
    Octokit: MockOctokit,
    _listEventsForTimelineMock: listEventsForTimelineMock,
  };
});

const moment = require('moment');

describe('GitHub issue processing', () => {
  let convertIssue;
  let processGitHubIssues;
  let listEventsForTimelineMock;
  let clientMock;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    const octokitModule = require('@octokit/rest');
    listEventsForTimelineMock = octokitModule._listEventsForTimelineMock;
    const index = require('../index.js');
    convertIssue = index.convertIssue;
    processGitHubIssues = index.processGitHubIssues;
    const { Client } = require('@elastic/elasticsearch');
    clientMock = Client.mock.instances[0];
  });

  describe('convertIssue', () => {
    describe('transferred issue', () => {
      it('handles transferred_at date etc.', () => {
        const rawIssue = {
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
          body: 'This is a test issue body',
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
            eyes: 0
          },
          timeline: [
            {
              event: 'transferred',
              created_at: '2022-01-02T11:30:00Z',
              previous_repository: { full_name: 'oldOwner/oldRepo' },
              repository: { full_name: 'someNewOwner/someNewRepo' }
            }
          ]
        };
        const result = convertIssue('owner', 'repo', rawIssue);
        expect(result.id).toBe(12345);
        expect(result.is_transferred).toBe(true);
        expect(result.moved_from).toBe('oldOwner/oldRepo');
        expect(result.moved_to).toBe('someNewOwner/someNewRepo');
        expect(moment(result.transferred_at.time).utc().format()).toBe('2022-01-02T11:30:00Z');
      });
    });
  });

  describe('processGitHubIssues', () => {
    const owner = 'someOwner';
    const repo = 'someRepo';
    const page = 1;
    const indexName = 'issues-someOwner-someRepo';
    const logDisplayName = 'TEST_REPO';

    it('calls timeline API only for open issues', async () => {
      const fakeIssues = [
        { number: 101, state: 'open', labels: [], user: { login: 'user1' } },
        { number: 202, state: 'closed', labels: [], user: { login: 'user2' } },
      ];
      const response = { data: fakeIssues, headers: { etag: '"some-etag"' } };
      listEventsForTimelineMock.mockResolvedValue({
        data: [{ event: 'some_event', created_at: moment().toISOString() }],
      });
      await processGitHubIssues(owner, repo, response, page, indexName, logDisplayName);
      expect(listEventsForTimelineMock).toHaveBeenCalledTimes(1);
      expect(listEventsForTimelineMock).toHaveBeenCalledWith({
        owner: 'someOwner',
        repo: 'someRepo',
        issue_number: 101,
      });
      if (clientMock) {
        expect(clientMock.bulk).toHaveBeenCalledTimes(1);
      }
    });

    it('does not call timeline API if no issues are returned', async () => {
      const response = { data: [], headers: { etag: '"some-etag"' } };
      await processGitHubIssues(owner, repo, response, page, indexName, logDisplayName);
      expect(listEventsForTimelineMock).not.toHaveBeenCalled();
      if (clientMock) {
        expect(clientMock.bulk).toHaveBeenCalledTimes(1);
      }
    });
  });
});