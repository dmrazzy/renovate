import URL from 'node:url';
import { setTimeout } from 'timers/promises';
import is from '@sindresorhus/is';
import pMap from 'p-map';
import semver from 'semver';
import {
  CONFIG_GIT_URL_UNAVAILABLE,
  REPOSITORY_ACCESS_FORBIDDEN,
  REPOSITORY_ARCHIVED,
  REPOSITORY_CHANGED,
  REPOSITORY_DISABLED,
  REPOSITORY_EMPTY,
  REPOSITORY_MIRRORED,
  REPOSITORY_NOT_FOUND,
  TEMPORARY_ERROR,
} from '../../../constants/error-messages';
import { logger } from '../../../logger';
import type { BranchStatus } from '../../../types';
import { coerceArray } from '../../../util/array';
import { noLeadingAtSymbol, parseJson } from '../../../util/common';
import { getEnv } from '../../../util/env';
import * as git from '../../../util/git';
import * as hostRules from '../../../util/host-rules';
import { memCacheProvider } from '../../../util/http/cache/memory-http-cache-provider';
import type { GitlabHttpOptions } from '../../../util/http/gitlab';
import { setBaseUrl } from '../../../util/http/gitlab';
import type { HttpResponse } from '../../../util/http/types';
import { parseInteger } from '../../../util/number';
import * as p from '../../../util/promises';
import { regEx } from '../../../util/regex';
import { sanitize } from '../../../util/sanitize';
import {
  ensureTrailingSlash,
  getQueryString,
  parseUrl,
} from '../../../util/url';
import type {
  AutodiscoverConfig,
  BranchStatusConfig,
  CreatePRConfig,
  EnsureCommentConfig,
  EnsureCommentRemovalConfig,
  EnsureIssueConfig,
  FindPRConfig,
  GitUrlOption,
  Issue,
  MergePRConfig,
  PlatformParams,
  PlatformPrOptions,
  PlatformResult,
  Pr,
  ReattemptPlatformAutomergeConfig,
  RepoParams,
  RepoResult,
  UpdatePrConfig,
} from '../types';
import { repoFingerprint } from '../util';
import { smartTruncate } from '../utils/pr-body';
import {
  getMemberUserIDs,
  getMemberUsernames,
  getUserID,
  gitlabApi,
  isUserBusy,
} from './http';
import { getMR, updateMR } from './merge-request';
import { GitlabPrCache } from './pr-cache';
import { LastPipelineId } from './schema';
import type {
  GitLabMergeRequest,
  GitlabComment,
  GitlabIssue,
  GitlabPr,
  MergeMethod,
  RepoResponse,
} from './types';
import { DRAFT_PREFIX, DRAFT_PREFIX_DEPRECATED, prInfo } from './utils';
export { extractRulesFromCodeOwnersLines } from './code-owners';

let config: {
  repository: string;
  email: string;
  issueList: GitlabIssue[] | undefined;
  mergeMethod: MergeMethod;
  mergeTrainsEnabled: boolean;
  defaultBranch: string;
  cloneSubmodules: boolean | undefined;
  cloneSubmodulesFilter: string[] | undefined;
  ignorePrAuthor: boolean | undefined;
  squash: boolean;
} = {} as any;

export function resetPlatform(): void {
  config = {} as any;
  draftPrefix = DRAFT_PREFIX;
  defaults.hostType = 'gitlab';
  defaults.endpoint = 'https://gitlab.com/api/v4/';
  defaults.version = '0.0.0';
  setBaseUrl(defaults.endpoint);
}

const defaults = {
  hostType: 'gitlab',
  endpoint: 'https://gitlab.com/api/v4/',
  version: '0.0.0',
};

export const id = 'gitlab';

let draftPrefix = DRAFT_PREFIX;
let botUserName: string;

export async function initPlatform({
  endpoint,
  username,
  token,
  gitAuthor,
}: PlatformParams): Promise<PlatformResult> {
  if (!token) {
    throw new Error('Init: You must configure a GitLab personal access token');
  }
  if (endpoint) {
    defaults.endpoint = ensureTrailingSlash(endpoint);
    setBaseUrl(defaults.endpoint);
  } else {
    logger.debug('Using default GitLab endpoint: ' + defaults.endpoint);
  }
  const platformConfig: PlatformResult = {
    endpoint: defaults.endpoint,
  };
  let gitlabVersion: string;
  try {
    if (!gitAuthor) {
      const user = (
        await gitlabApi.getJsonUnchecked<{
          email: string;
          name: string;
          id: number;
          commit_email?: string;
        }>(`user`, { token })
      ).body;
      platformConfig.gitAuthor = `${user.name} <${
        user.commit_email ?? user.email
      }>`;
      botUserName = user.name;
    }
    const env = getEnv();
    /* v8 ignore start: experimental feature */
    if (env.RENOVATE_X_PLATFORM_VERSION) {
      gitlabVersion = env.RENOVATE_X_PLATFORM_VERSION;
    } /* v8 ignore stop */ else {
      const version = (
        await gitlabApi.getJsonUnchecked<{ version: string }>('version', {
          token,
        })
      ).body;
      gitlabVersion = version.version;
    }
    logger.debug('GitLab version is: ' + gitlabVersion);
    // version is 'x.y.z-edition', so not strictly semver; need to strip edition
    [gitlabVersion] = gitlabVersion.split('-');
    defaults.version = gitlabVersion;
  } catch (err) {
    logger.debug(
      { err },
      'Error authenticating with GitLab. Check that your token includes "api" permissions',
    );
    throw new Error('Init: Authentication failure');
  }
  draftPrefix = semver.lt(defaults.version, '13.2.0')
    ? DRAFT_PREFIX_DEPRECATED
    : DRAFT_PREFIX;

  botUserName ??= username!;

  return platformConfig;
}

// Get all repositories that the user has access to
export async function getRepos(config?: AutodiscoverConfig): Promise<string[]> {
  logger.debug('Autodiscovering GitLab repositories');

  const queryParams: Record<string, any> = {
    membership: true,
    per_page: 100,
    with_merge_requests_enabled: true,
    min_access_level: 30,
    archived: false,
  };
  if (config?.topics?.length) {
    queryParams.topic = config.topics.join(',');
  }

  const urls = [];
  if (config?.namespaces?.length) {
    queryParams.with_shared = false;
    queryParams.include_subgroups = true;
    urls.push(
      ...config.namespaces.map(
        (namespace) =>
          `groups/${urlEscape(namespace)}/projects?${getQueryString(
            queryParams,
          )}`,
      ),
    );
  } else {
    urls.push('projects?' + getQueryString(queryParams));
  }

  try {
    const repos = (
      await pMap(
        urls,
        (url) =>
          gitlabApi.getJsonUnchecked<RepoResponse[]>(url, {
            paginate: true,
          }),
        {
          concurrency: 2,
        },
      )
    ).flatMap((response) => response.body);

    logger.debug(`Discovered ${repos.length} project(s)`);
    return repos
      .filter((repo) => !repo.mirror || config?.includeMirrors)
      .map((repo) => repo.path_with_namespace);
  } catch (err) {
    logger.error({ err }, `GitLab getRepos error`);
    throw err;
  }
}

function urlEscape(str: string): string;
function urlEscape(str: string | undefined): string | undefined;
function urlEscape(str: string | undefined): string | undefined {
  return str?.replace(regEx(/\//g), '%2F');
}

export async function getRawFile(
  fileName: string,
  repoName?: string,
  branchOrTag?: string,
): Promise<string | null> {
  const escapedFileName = urlEscape(fileName);
  const repo = urlEscape(repoName) ?? config.repository;
  const url =
    `projects/${repo}/repository/files/${escapedFileName}?ref=` +
    (branchOrTag ?? `HEAD`);
  const res = await gitlabApi.getJsonUnchecked<{ content: string }>(url, {
    cacheProvider: memCacheProvider,
  });
  const buf = res.body.content;
  const str = Buffer.from(buf, 'base64').toString();
  return str;
}

export async function getJsonFile(
  fileName: string,
  repoName?: string,
  branchOrTag?: string,
): Promise<any> {
  const raw = await getRawFile(fileName, repoName, branchOrTag);
  return parseJson(raw, fileName);
}

function getRepoUrl(
  repository: string,
  gitUrl: GitUrlOption | undefined,
  res: HttpResponse<RepoResponse>,
): string {
  if (gitUrl === 'ssh') {
    if (!res.body.ssh_url_to_repo) {
      throw new Error(CONFIG_GIT_URL_UNAVAILABLE);
    }
    logger.debug(`Using ssh URL: ${res.body.ssh_url_to_repo}`);
    return res.body.ssh_url_to_repo;
  }

  const opts = hostRules.find({
    hostType: defaults.hostType,
    url: defaults.endpoint,
  });
  const env = getEnv();

  if (
    gitUrl === 'endpoint' ||
    is.nonEmptyString(env.GITLAB_IGNORE_REPO_URL) ||
    res.body.http_url_to_repo === null
  ) {
    if (res.body.http_url_to_repo === null) {
      logger.debug('no http_url_to_repo found. Falling back to old behavior.');
    }
    if (env.GITLAB_IGNORE_REPO_URL) {
      logger.warn(
        'GITLAB_IGNORE_REPO_URL environment variable is deprecated. Please use "gitUrl" option.',
      );
    }

    // TODO: null check (#22198)
    const { protocol, host, pathname } = parseUrl(defaults.endpoint)!;
    const newPathname = pathname.slice(0, pathname.indexOf('/api'));
    const url = URL.format({
      protocol:
        /* v8 ignore next: should never happen */
        protocol.slice(0, -1) || 'https',
      // TODO: types (#22198)
      auth: `oauth2:${opts.token!}`,
      host,
      pathname: `${newPathname}/${repository}.git`,
    });
    logger.debug(`Using URL based on configured endpoint, url:${url}`);
    return url;
  }

  logger.debug(`Using http URL: ${res.body.http_url_to_repo}`);
  const repoUrl = URL.parse(`${res.body.http_url_to_repo}`);
  // TODO: types (#22198)
  repoUrl.auth = `oauth2:${opts.token!}`;
  return URL.format(repoUrl);
}

// Initialize GitLab by getting base branch
export async function initRepo({
  repository,
  cloneSubmodules,
  cloneSubmodulesFilter,
  ignorePrAuthor,
  gitUrl,
  endpoint,
  includeMirrors,
}: RepoParams): Promise<RepoResult> {
  config = {} as any;
  config.repository = urlEscape(repository);
  config.cloneSubmodules = cloneSubmodules;
  config.cloneSubmodulesFilter = cloneSubmodulesFilter;
  config.ignorePrAuthor = ignorePrAuthor;

  let res: HttpResponse<RepoResponse>;
  try {
    res = await gitlabApi.getJsonUnchecked<RepoResponse>(
      `projects/${config.repository}`,
    );
    if (res.body.archived) {
      logger.debug(
        'Repository is archived - throwing error to abort renovation',
      );
      throw new Error(REPOSITORY_ARCHIVED);
    }

    if (res.body.mirror && includeMirrors !== true) {
      logger.debug(
        'Repository is a mirror - throwing error to abort renovation',
      );
      throw new Error(REPOSITORY_MIRRORED);
    }
    if (res.body.repository_access_level === 'disabled') {
      logger.debug(
        'Repository portion of project is disabled - throwing error to abort renovation',
      );
      throw new Error(REPOSITORY_DISABLED);
    }
    if (res.body.merge_requests_access_level === 'disabled') {
      logger.debug(
        'MRs are disabled for the project - throwing error to abort renovation',
      );
      throw new Error(REPOSITORY_DISABLED);
    }
    if (res.body.default_branch === null || res.body.empty_repo) {
      throw new Error(REPOSITORY_EMPTY);
    }
    config.defaultBranch = res.body.default_branch;
    /* v8 ignore start */
    if (!config.defaultBranch) {
      logger.warn({ resBody: res.body }, 'Error fetching GitLab project');
      throw new Error(TEMPORARY_ERROR);
    } /* v8 ignore stop */
    config.mergeMethod = res.body.merge_method || 'merge';
    config.mergeTrainsEnabled = res.body.merge_trains_enabled ?? false;
    if (res.body.squash_option) {
      config.squash =
        res.body.squash_option === 'always' ||
        res.body.squash_option === 'default_on';
    }
    logger.debug(`${repository} default branch = ${config.defaultBranch}`);
    logger.debug('Enabling Git FS');
    const url = getRepoUrl(repository, gitUrl, res);
    await git.initRepo({
      ...config,
      url,
    });
  } catch (err) /* v8 ignore start */ {
    logger.debug({ err }, 'Caught initRepo error');
    if (err.message.includes('HEAD is not a symbolic ref')) {
      throw new Error(REPOSITORY_EMPTY);
    }
    if ([REPOSITORY_ARCHIVED, REPOSITORY_EMPTY].includes(err.message)) {
      throw err;
    }
    if (err.statusCode === 403) {
      throw new Error(REPOSITORY_ACCESS_FORBIDDEN);
    }
    if (err.statusCode === 404) {
      throw new Error(REPOSITORY_NOT_FOUND);
    }
    if (err.message === REPOSITORY_DISABLED) {
      throw err;
    }
    logger.debug({ err }, 'Unknown GitLab initRepo error');
    throw err;
  } /* v8 ignore stop */
  const repoConfig: RepoResult = {
    defaultBranch: config.defaultBranch,
    isFork: !!res.body.forked_from_project,
    repoFingerprint: repoFingerprint(res.body.id, defaults.endpoint),
  };
  return repoConfig;
}

export function getBranchForceRebase(): Promise<boolean> {
  const forceRebase =
    config?.mergeMethod !== 'merge' && !config.mergeTrainsEnabled;
  if (forceRebase) {
    logger.once.debug(
      `mergeMethod is ${config.mergeMethod} so PRs will be kept up-to-date with base branch`,
    );
  }
  return Promise.resolve(forceRebase);
}

type BranchState =
  | 'pending'
  | 'created'
  | 'running'
  | 'waiting_for_resource'
  | 'manual'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'skipped'
  | 'scheduled';

interface GitlabBranchStatus {
  status: BranchState;
  name: string;
  allow_failure?: boolean;
}

async function getStatus(
  branchName: string,
  useCache = true,
): Promise<GitlabBranchStatus[]> {
  const branchSha = git.getBranchCommit(branchName);
  try {
    // TODO: types (#22198)
    const url = `projects/${
      config.repository
    }/repository/commits/${branchSha!}/statuses`;

    const opts: GitlabHttpOptions = { paginate: true };
    if (useCache) {
      opts.cacheProvider = memCacheProvider;
    } else {
      opts.memCache = false;
    }

    return (await gitlabApi.getJsonUnchecked<GitlabBranchStatus[]>(url, opts))
      .body;
  } catch (err) /* v8 ignore start */ {
    logger.debug({ err }, 'Error getting commit status');
    if (err.response?.statusCode === 404) {
      throw new Error(REPOSITORY_CHANGED);
    }
    throw err;
  } /* v8 ignore stop */
}

const gitlabToRenovateStatusMapping: Record<BranchState, BranchStatus> = {
  pending: 'yellow',
  created: 'yellow',
  manual: 'yellow',
  running: 'yellow',
  waiting_for_resource: 'yellow',
  success: 'green',
  failed: 'red',
  canceled: 'red',
  skipped: 'red',
  scheduled: 'yellow',
};

// Returns the combined status for a branch.
export async function getBranchStatus(
  branchName: string,
  internalChecksAsSuccess: boolean,
): Promise<BranchStatus> {
  logger.debug(`getBranchStatus(${branchName})`);

  if (!git.branchExists(branchName)) {
    throw new Error(REPOSITORY_CHANGED);
  }

  const branchStatuses = await getStatus(branchName);
  /* v8 ignore start */
  if (!is.array(branchStatuses)) {
    logger.warn(
      { branchName, branchStatuses },
      'Empty or unexpected branch statuses',
    );
    return 'yellow';
  } /* v8 ignore stop */
  logger.debug(`Got res with ${branchStatuses.length} results`);

  const mr = await getBranchPr(branchName);
  if (mr && mr.sha !== mr.headPipelineSha && mr.headPipelineStatus) {
    logger.debug(
      'Merge request head pipeline has different sha to commit, assuming merged results pipeline',
    );
    branchStatuses.push({
      status: mr.headPipelineStatus as BranchState,
      name: 'head_pipeline',
    });
  }
  // ignore all skipped jobs
  const res = branchStatuses.filter((check) => check.status !== 'skipped');
  if (res.length === 0) {
    // Return 'pending' if we have no status checks
    return 'yellow';
  }
  if (
    !internalChecksAsSuccess &&
    branchStatuses.every(
      (check) =>
        check.name?.startsWith('renovate/') &&
        gitlabToRenovateStatusMapping[check.status] === 'green',
    )
  ) {
    logger.debug(
      'Successful checks are all internal renovate/ checks, so returning "pending" branch status',
    );
    return 'yellow';
  }
  let status: BranchStatus = 'green'; // default to green
  res
    .filter((check) => !check.allow_failure)
    .forEach((check) => {
      if (status !== 'red') {
        // if red, stay red
        let mappedStatus: BranchStatus =
          gitlabToRenovateStatusMapping[check.status];
        if (!mappedStatus) {
          logger.warn(
            { check },
            'Could not map GitLab check.status to Renovate status',
          );
          mappedStatus = 'yellow';
        }
        if (mappedStatus !== 'green') {
          logger.trace({ check }, 'Found non-green check');
          status = mappedStatus;
        }
      }
    });
  return status;
}

// Pull Request
export async function getPrList(): Promise<Pr[]> {
  return await GitlabPrCache.getPrs(
    gitlabApi,
    config.repository,
    botUserName,
    !!config.ignorePrAuthor,
  );
}

async function ignoreApprovals(pr: number): Promise<void> {
  try {
    const url = `projects/${config.repository}/merge_requests/${pr}/approval_rules`;
    const { body: rules } = await gitlabApi.getJsonUnchecked<
      {
        name: string;
        rule_type: string;
        id: number;
      }[]
    >(url);

    const ruleName = 'renovateIgnoreApprovals';

    const existingAnyApproverRule = rules?.find(
      ({ rule_type }) => rule_type === 'any_approver',
    );
    const existingRegularApproverRules = rules?.filter(
      ({ rule_type, name }) =>
        rule_type !== 'any_approver' &&
        name !== ruleName &&
        rule_type !== 'report_approver' &&
        rule_type !== 'code_owner',
    );

    if (existingRegularApproverRules?.length) {
      await p.all(
        existingRegularApproverRules.map((rule) => async (): Promise<void> => {
          await gitlabApi.deleteJson(`${url}/${rule.id}`);
        }),
      );
    }

    if (existingAnyApproverRule) {
      await gitlabApi.putJson(`${url}/${existingAnyApproverRule.id}`, {
        body: { ...existingAnyApproverRule, approvals_required: 0 },
      });
      return;
    }

    const zeroApproversRule = rules?.find(({ name }) => name === ruleName);
    if (!zeroApproversRule) {
      await gitlabApi.postJson(url, {
        body: {
          name: ruleName,
          approvals_required: 0,
        },
      });
    }
  } catch (err) {
    logger.warn({ err }, 'GitLab: Error adding approval rule');
  }
}

async function tryPrAutomerge(
  pr: number,
  platformPrOptions: PlatformPrOptions | undefined,
): Promise<void> {
  try {
    if (platformPrOptions?.gitLabIgnoreApprovals) {
      await ignoreApprovals(pr);
    }

    if (platformPrOptions?.usePlatformAutomerge) {
      // https://docs.gitlab.com/ee/api/merge_requests.html#merge-status
      const desiredDetailedMergeStatus = [
        'mergeable',
        'ci_still_running',
        'not_approved',
      ];
      const desiredPipelineStatus = [
        'failed', // don't lose time if pipeline failed
        'running', // pipeline is running, no need to wait for it
      ];
      const desiredStatus = 'can_be_merged';
      const env = getEnv();
      // The default value of 5 attempts results in max. 13.75 seconds timeout if no pipeline created.
      const retryTimes = parseInteger(
        env.RENOVATE_X_GITLAB_AUTO_MERGEABLE_CHECK_ATTEMPS,
        5,
      );

      const mergeDelay = parseInteger(
        env.RENOVATE_X_GITLAB_MERGE_REQUEST_DELAY,
        250,
      );

      // Check for correct merge request status before setting `merge_when_pipeline_succeeds` to  `true`.
      for (let attempt = 1; attempt <= retryTimes; attempt += 1) {
        const { body } = await gitlabApi.getJsonUnchecked<{
          merge_status: string;
          detailed_merge_status?: string;
          pipeline: {
            status: string;
          };
        }>(`projects/${config.repository}/merge_requests/${pr}`, {
          memCache: false,
        });
        // detailed_merge_status is available with Gitlab >=15.6.0
        const use_detailed_merge_status = !!body.detailed_merge_status;
        const detailed_merge_status_check =
          use_detailed_merge_status &&
          desiredDetailedMergeStatus.includes(body.detailed_merge_status!);
        // merge_status is deprecated with Gitlab >= 15.6
        const deprecated_merge_status_check =
          !use_detailed_merge_status && body.merge_status === desiredStatus;

        // Only continue if the merge request can be merged and has a pipeline.
        if (
          (detailed_merge_status_check || deprecated_merge_status_check) &&
          body.pipeline !== null &&
          desiredPipelineStatus.includes(body.pipeline.status)
        ) {
          break;
        }
        logger.debug(`PR not yet in mergeable state. Retrying ${attempt}`);
        await setTimeout(mergeDelay * attempt ** 2); // exponential backoff
      }

      // Even if Gitlab returns a "merge-able" merge request status, enabling auto-merge sometimes
      // returns a 405 Method Not Allowed. It seems to be a timing issue within Gitlab.
      for (let attempt = 1; attempt <= retryTimes; attempt += 1) {
        try {
          await gitlabApi.putJson(
            `projects/${config.repository}/merge_requests/${pr}/merge`,
            {
              body: {
                should_remove_source_branch: true,
                merge_when_pipeline_succeeds: true,
              },
            },
          );
          break;
        } catch (err) {
          logger.debug(
            { err },
            `Automerge on PR creation failed. Retrying ${attempt}`,
          );
        }
        await setTimeout(mergeDelay * attempt ** 2); // exponential backoff
      }
    }
  } catch (err) /* v8 ignore start */ {
    logger.debug({ err }, 'Automerge on PR creation failed');
  } /* v8 ignore stop */
}

async function approveMr(mrNumber: number): Promise<void> {
  logger.debug(`approveMr(${mrNumber})`);
  try {
    await gitlabApi.postJson(
      `projects/${config.repository}/merge_requests/${mrNumber}/approve`,
    );
  } catch (err) {
    logger.warn({ err }, 'GitLab: Error approving merge request');
  }
}

export async function createPr({
  sourceBranch,
  targetBranch,
  prTitle,
  prBody: rawDescription,
  draftPR,
  labels,
  platformPrOptions,
}: CreatePRConfig): Promise<Pr> {
  let title = prTitle;
  if (draftPR) {
    title = draftPrefix + title;
  }
  const description = sanitize(rawDescription);
  logger.debug(`Creating Merge Request: ${title}`);
  const res = await gitlabApi.postJson<GitLabMergeRequest>(
    `projects/${config.repository}/merge_requests`,
    {
      body: {
        source_branch: sourceBranch,
        target_branch: targetBranch,
        remove_source_branch: true,
        title,
        description,
        labels: (labels ?? []).join(','),
        squash: config.squash,
      },
    },
  );

  const pr = prInfo(res.body);
  await GitlabPrCache.setPr(
    gitlabApi,
    config.repository,
    botUserName,
    pr,
    !!config.ignorePrAuthor,
  );

  if (platformPrOptions?.autoApprove) {
    await approveMr(pr.number);
  }

  await tryPrAutomerge(pr.number, platformPrOptions);

  return pr;
}

export async function getPr(iid: number): Promise<GitlabPr> {
  logger.debug(`getPr(${iid})`);
  const mr = await getMR(config.repository, iid);

  // Harmonize fields with GitHub
  return prInfo(mr);
}

export async function updatePr({
  number: iid,
  prTitle,
  prBody: description,
  addLabels,
  removeLabels,
  state,
  platformPrOptions,
  targetBranch,
}: UpdatePrConfig): Promise<void> {
  let title = prTitle;
  if ((await getPrList()).find((pr) => pr.number === iid)?.isDraft) {
    title = draftPrefix + title;
  }
  const newState = {
    ['closed']: 'close',
    ['open']: 'reopen',
    // TODO: null check (#22198)
  }[state!];

  const body: any = {
    title,
    description: sanitize(description),
    ...(newState && { state_event: newState }),
  };
  if (targetBranch) {
    body.target_branch = targetBranch;
  }

  if (addLabels) {
    body.add_labels = addLabels;
  }

  if (removeLabels) {
    body.remove_labels = removeLabels;
  }

  const updatedPrInfo = (
    await gitlabApi.putJson<GitLabMergeRequest>(
      `projects/${config.repository}/merge_requests/${iid}`,
      { body },
    )
  ).body;

  const updatedPr = prInfo(updatedPrInfo);
  await GitlabPrCache.setPr(
    gitlabApi,
    config.repository,
    botUserName,
    updatedPr,
    !!config.ignorePrAuthor,
  );

  if (platformPrOptions?.autoApprove) {
    await approveMr(iid);
  }
}

export async function reattemptPlatformAutomerge({
  number: iid,
  platformPrOptions,
}: ReattemptPlatformAutomergeConfig): Promise<void> {
  await tryPrAutomerge(iid, platformPrOptions);

  logger.debug(`PR platform automerge re-attempted...prNo: ${iid}`);
}

export async function mergePr({ id }: MergePRConfig): Promise<boolean> {
  try {
    await gitlabApi.putJson(
      `projects/${config.repository}/merge_requests/${id}/merge`,
      {
        body: {
          should_remove_source_branch: true,
        },
      },
    );
    return true;
  } catch (err) /* v8 ignore start */ {
    if (err.statusCode === 401) {
      logger.debug('No permissions to merge PR');
      return false;
    }
    if (err.statusCode === 406) {
      logger.debug({ err }, 'PR not acceptable for merging');
      return false;
    }
    logger.debug({ err }, 'merge PR error');
    logger.debug('PR merge failed');
    return false;
  } /* v8 ignore stop */
}

export function massageMarkdown(input: string): string {
  const desc = input
    .replace(regEx(/Pull Request/g), 'Merge Request')
    .replace(regEx(/\bPR\b/g), 'MR')
    .replace(regEx(/\bPRs\b/g), 'MRs')
    .replace(regEx(/\]\(\.\.\/pull\//g), '](!')
    // Strip unicode null characters as GitLab markdown does not permit them
    .replace(regEx(/\u0000/g), ''); // eslint-disable-line no-control-regex
  return smartTruncate(desc, maxBodyLength());
}

export function maxBodyLength(): number {
  if (semver.lt(defaults.version, '13.4.0')) {
    logger.debug(
      { version: defaults.version },
      'GitLab versions earlier than 13.4 have issues with long descriptions, truncating to 25K characters',
    );
    return 25000;
  } else {
    return 1000000;
  }
}

/* v8 ignore start: no need to test */
export function labelCharLimit(): number {
  return 255;
}
/* v8 ignore stop */

// Branch

function matchesState(state: string, desiredState: string): boolean {
  if (desiredState === 'all') {
    return true;
  }
  if (desiredState.startsWith('!')) {
    return state !== desiredState.substring(1);
  }
  return state === desiredState;
}

export async function findPr({
  branchName,
  prTitle,
  state = 'all',
  includeOtherAuthors,
}: FindPRConfig): Promise<Pr | null> {
  logger.debug(`findPr(${branchName}, ${prTitle!}, ${state})`);

  if (includeOtherAuthors) {
    // PR might have been created by anyone, so don't use the cached Renovate MR list
    const response = await gitlabApi.getJsonUnchecked<GitLabMergeRequest[]>(
      `projects/${config.repository}/merge_requests?source_branch=${branchName}&state=opened`,
    );

    const { body: mrList } = response;
    if (!mrList.length) {
      logger.debug(`No MR found for branch ${branchName}`);
      return null;
    }

    return prInfo(mrList[0]);
  }

  const prList = await getPrList();
  return (
    prList.find(
      (p: { sourceBranch: string; title: string; state: string }) =>
        p.sourceBranch === branchName &&
        (!prTitle || p.title.toUpperCase() === prTitle.toUpperCase()) &&
        matchesState(p.state, state),
    ) ?? null
  );
}

// Returns the Pull Request for a branch. Null if not exists.
export async function getBranchPr(
  branchName: string,
): Promise<GitlabPr | null> {
  logger.debug(`getBranchPr(${branchName})`);
  const existingPr = await findPr({
    branchName,
    state: 'open',
  });
  return existingPr ? getPr(existingPr.number) : null;
}

export async function getBranchStatusCheck(
  branchName: string,
  context: string,
): Promise<BranchStatus | null> {
  // cache-bust in case we have rebased
  const res = await getStatus(branchName, false);
  logger.debug(`Got res with ${res.length} results`);
  for (const check of res) {
    if (check.name === context) {
      return gitlabToRenovateStatusMapping[check.status] || 'yellow';
    }
  }
  return null;
}

export async function setBranchStatus({
  branchName,
  context,
  description,
  state: renovateState,
  url: targetUrl,
}: BranchStatusConfig): Promise<void> {
  // First, get the branch commit SHA
  const branchSha = git.getBranchCommit(branchName);
  if (!branchSha) {
    logger.warn('Failed to get the branch commit SHA');
    return;
  }
  // Now, check the statuses for that commit
  const url = `projects/${config.repository}/statuses/${branchSha}`;
  let state = 'success';
  if (renovateState === 'yellow') {
    state = 'pending';
  } else if (renovateState === 'red') {
    state = 'failed';
  }
  const options: any = {
    state,
    description,
    context,
  };

  if (targetUrl) {
    options.target_url = targetUrl;
  }

  const env = getEnv();
  const retryTimes = parseInteger(
    env.RENOVATE_X_GITLAB_BRANCH_STATUS_CHECK_ATTEMPTS,
    2,
  );

  try {
    for (let attempt = 1; attempt <= retryTimes + 1; attempt += 1) {
      const commitUrl = `projects/${config.repository}/repository/commits/${branchSha}`;
      await gitlabApi
        .getJsonSafe(commitUrl, { memCache: false }, LastPipelineId)
        .onValue((pipelineId) => {
          options.pipeline_id = pipelineId;
        });
      if (options.pipeline_id !== undefined) {
        break;
      }
      if (attempt >= retryTimes + 1) {
        logger.debug(`Pipeline not yet created after ${attempt} attempts`);
      } else {
        logger.debug(`Pipeline not yet created. Retrying ${attempt}`);
      }
      // give gitlab some time to create pipelines for the sha
      await setTimeout(
        parseInteger(env.RENOVATE_X_GITLAB_BRANCH_STATUS_DELAY, 1000),
      );
    }
  } catch (err) {
    logger.debug({ err });
    logger.warn('Failed to retrieve commit pipeline');
  }

  try {
    await gitlabApi.postJson(url, { body: options });

    // update status cache
    await getStatus(branchName, false);
  } catch (err) /* v8 ignore start */ {
    if (
      err.body?.message?.startsWith(
        'Cannot transition status via :enqueue from :pending',
      )
    ) {
      // https://gitlab.com/gitlab-org/gitlab-foss/issues/25807
      logger.debug('Ignoring status transition error');
    } else {
      logger.debug({ err });
      logger.warn('Failed to set branch status');
    }
  } /* v8 ignore stop */
}

// Issue

export async function getIssueList(): Promise<GitlabIssue[]> {
  if (!config.issueList) {
    const searchParams: Record<string, string> = {
      per_page: '100',
      state: 'opened',
    };
    if (!config.ignorePrAuthor) {
      searchParams.scope = 'created_by_me';
    }
    const query = getQueryString(searchParams);
    const res = await gitlabApi.getJsonUnchecked<
      { iid: number; title: string; labels: string[] }[]
    >(`projects/${config.repository}/issues?${query}`, {
      memCache: false,
      paginate: true,
    });
    /* v8 ignore start */
    if (!is.array(res.body)) {
      logger.warn({ responseBody: res.body }, 'Could not retrieve issue list');
      return [];
    } /* v8 ignore stop */
    config.issueList = res.body.map((i) => ({
      iid: i.iid,
      title: i.title,
      labels: i.labels,
    }));
  }
  return config.issueList;
}

export async function getIssue(
  number: number,
  useCache = true,
): Promise<Issue | null> {
  try {
    const opts: GitlabHttpOptions = {};
    /* v8 ignore start: temporary code */
    if (useCache) {
      opts.cacheProvider = memCacheProvider;
    } else {
      opts.memCache = false;
    } /* v8 ignore stop */
    const issueBody = (
      await gitlabApi.getJsonUnchecked<{ description: string }>(
        `projects/${config.repository}/issues/${number}`,
        opts,
      )
    ).body.description;
    return {
      number,
      body: issueBody,
    };
  } catch (err) /* v8 ignore start */ {
    logger.debug({ err, number }, 'Error getting issue');
    return null;
  } /* v8 ignore stop */
}

export async function findIssue(title: string): Promise<Issue | null> {
  logger.debug(`findIssue(${title})`);
  try {
    const issueList = await getIssueList();
    const issue = issueList.find((i) => i.title === title);
    if (!issue) {
      return null;
    }
    return await getIssue(issue.iid);
  } catch /* v8 ignore start */ {
    logger.warn('Error finding issue');
    return null;
  } /* v8 ignore stop */
}

export async function ensureIssue({
  title,
  reuseTitle,
  body,
  labels,
  confidential,
}: EnsureIssueConfig): Promise<'updated' | 'created' | null> {
  logger.debug(`ensureIssue()`);
  const description = massageMarkdown(sanitize(body));
  try {
    const issueList = await getIssueList();
    let issue = issueList.find((i) => i.title === title);
    issue ??= issueList.find((i) => i.title === reuseTitle);
    if (issue) {
      const existingDescription = (
        await gitlabApi.getJsonUnchecked<{ description: string }>(
          `projects/${config.repository}/issues/${issue.iid}`,
        )
      ).body.description;
      if (issue.title !== title || existingDescription !== description) {
        logger.debug('Updating issue');
        await gitlabApi.putJson(
          `projects/${config.repository}/issues/${issue.iid}`,
          {
            body: {
              title,
              description,
              labels: (labels ?? issue.labels ?? []).join(','),
              confidential: confidential ?? false,
            },
          },
        );
        return 'updated';
      }
    } else {
      await gitlabApi.postJson(`projects/${config.repository}/issues`, {
        body: {
          title,
          description,
          labels: (labels ?? []).join(','),
          confidential: confidential ?? false,
        },
      });
      logger.info('Issue created');
      // delete issueList so that it will be refetched as necessary
      delete config.issueList;
      return 'created';
    }
  } catch (err) /* v8 ignore start */ {
    if (err.message.startsWith('Issues are disabled for this repo')) {
      logger.debug(`Could not create issue: ${(err as Error).message}`);
    } else {
      logger.warn({ err }, 'Could not ensure issue');
    }
  } /* v8 ignore stop */
  return null;
}

export async function ensureIssueClosing(title: string): Promise<void> {
  logger.debug(`ensureIssueClosing()`);
  const issueList = await getIssueList();
  for (const issue of issueList) {
    if (issue.title === title) {
      logger.debug({ issue }, 'Closing issue');
      await gitlabApi.putJson(
        `projects/${config.repository}/issues/${issue.iid}`,
        {
          body: { state_event: 'close' },
        },
      );
    }
  }
}

export async function addAssignees(
  iid: number,
  assignees: string[],
): Promise<void> {
  try {
    logger.debug(`Adding assignees '${assignees.join(', ')}' to #${iid}`);
    const assigneeIds: number[] = [];
    for (const assignee of assignees) {
      try {
        const userId = await getUserID(assignee);
        assigneeIds.push(userId);
      } catch (err) {
        logger.debug({ assignee, err }, 'getUserID() error');
        logger.warn({ assignee }, 'Failed to add assignee - could not get ID');
      }
    }
    const url = `projects/${
      config.repository
    }/merge_requests/${iid}?${getQueryString({
      'assignee_ids[]': assigneeIds,
    })}`;
    await gitlabApi.putJson(url);
  } catch (err) {
    logger.debug({ err }, 'addAssignees error');
    logger.warn({ iid, assignees }, 'Failed to add assignees');
  }
}

export async function addReviewers(
  iid: number,
  reviewers: string[],
): Promise<void> {
  logger.debug(`Adding reviewers '${reviewers.join(', ')}' to #${iid}`);

  if (semver.lt(defaults.version, '13.9.0')) {
    logger.warn(
      { version: defaults.version },
      'Adding reviewers is only available in GitLab 13.9 and onwards',
    );
    return;
  }

  let mr: GitLabMergeRequest;
  try {
    mr = await getMR(config.repository, iid);
  } catch (err) {
    logger.warn({ err }, 'Failed to get existing reviewers');
    return;
  }

  mr.reviewers = coerceArray(mr.reviewers);
  const existingReviewers = mr.reviewers.map((r) => r.username);
  const existingReviewerIDs = mr.reviewers.map((r) => r.id);

  // Figure out which reviewers (of the ones we want to add) are not already on the MR as a reviewer
  const newReviewers = reviewers.filter((r) => !existingReviewers.includes(r));

  // Gather the IDs for all the reviewers we want to add
  let newReviewerIDs: number[];
  try {
    newReviewerIDs = (
      await p.all(
        newReviewers.map((r) => async () => {
          try {
            return [await getUserID(r)];
          } catch {
            // Unable to fetch userId, try resolve as a group
            return getMemberUserIDs(r);
          }
        }),
      )
    ).flat();
  } catch (err) {
    logger.warn({ err }, 'Failed to get IDs of the new reviewers');
    return;
  }

  // Multiple groups may have the same members, so
  // filter out non-distinct values
  newReviewerIDs = [...new Set(newReviewerIDs)];

  try {
    await updateMR(config.repository, iid, {
      reviewer_ids: [...existingReviewerIDs, ...newReviewerIDs],
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to add reviewers');
  }
}

export async function deleteLabel(
  issueNo: number,
  label: string,
): Promise<void> {
  logger.debug(`Deleting label ${label} from #${issueNo}`);
  try {
    const pr = await getPr(issueNo);
    const labels = coerceArray(pr.labels)
      .filter((l: string) => l !== label)
      .join(',');
    await gitlabApi.putJson(
      `projects/${config.repository}/merge_requests/${issueNo}`,
      {
        body: { labels },
      },
    );
  } catch (err) /* v8 ignore start */ {
    logger.warn({ err, issueNo, label }, 'Failed to delete label');
  } /* v8 ignore stop */
}

async function getComments(issueNo: number): Promise<GitlabComment[]> {
  // GET projects/:owner/:repo/merge_requests/:number/notes
  logger.debug(`Getting comments for #${issueNo}`);
  const url = `projects/${config.repository}/merge_requests/${issueNo}/notes`;
  const comments = (
    await gitlabApi.getJsonUnchecked<GitlabComment[]>(url, { paginate: true })
  ).body;
  logger.debug(`Found ${comments.length} comments`);
  return comments;
}

async function addComment(issueNo: number, body: string): Promise<void> {
  // POST projects/:owner/:repo/merge_requests/:number/notes
  await gitlabApi.postJson(
    `projects/${config.repository}/merge_requests/${issueNo}/notes`,
    {
      body: { body },
    },
  );
}

async function editComment(
  issueNo: number,
  commentId: number,
  body: string,
): Promise<void> {
  // PUT projects/:owner/:repo/merge_requests/:number/notes/:id
  await gitlabApi.putJson(
    `projects/${config.repository}/merge_requests/${issueNo}/notes/${commentId}`,
    {
      body: { body },
    },
  );
}

async function deleteComment(
  issueNo: number,
  commentId: number,
): Promise<void> {
  // DELETE projects/:owner/:repo/merge_requests/:number/notes/:id
  await gitlabApi.deleteJson(
    `projects/${config.repository}/merge_requests/${issueNo}/notes/${commentId}`,
  );
}

export async function ensureComment({
  number,
  topic,
  content,
}: EnsureCommentConfig): Promise<boolean> {
  const sanitizedContent = sanitize(content);
  const massagedTopic = topic
    ? topic
        .replace(regEx(/Pull Request/g), 'Merge Request')
        .replace(regEx(/PR/g), 'MR')
    : topic;
  const comments = await getComments(number);
  let body: string;
  let commentId: number | undefined;
  let commentNeedsUpdating: boolean | undefined;
  // TODO: types (#22198)
  if (topic) {
    logger.debug(`Ensuring comment "${massagedTopic!}" in #${number}`);
    body = `### ${topic}\n\n${sanitizedContent}`;
    body = smartTruncate(
      body
        .replace(regEx(/Pull Request/g), 'Merge Request')
        .replace(regEx(/PR/g), 'MR'),
      maxBodyLength(),
    );
    comments.forEach((comment: { body: string; id: number }) => {
      if (comment.body.startsWith(`### ${massagedTopic!}\n\n`)) {
        commentId = comment.id;
        commentNeedsUpdating = comment.body !== body;
      }
    });
  } else {
    logger.debug(`Ensuring content-only comment in #${number}`);
    body = smartTruncate(`${sanitizedContent}`, maxBodyLength());
    comments.forEach((comment: { body: string; id: number }) => {
      if (comment.body === body) {
        commentId = comment.id;
        commentNeedsUpdating = false;
      }
    });
  }
  if (!commentId) {
    await addComment(number, body);
    logger.debug(
      { repository: config.repository, issueNo: number },
      'Added comment',
    );
  } else if (commentNeedsUpdating) {
    await editComment(number, commentId, body);
    logger.debug(
      { repository: config.repository, issueNo: number },
      'Updated comment',
    );
  } else {
    logger.debug('Comment is already update-to-date');
  }
  return true;
}

export async function ensureCommentRemoval(
  deleteConfig: EnsureCommentRemovalConfig,
): Promise<void> {
  const { number: issueNo } = deleteConfig;
  const key =
    deleteConfig.type === 'by-topic'
      ? deleteConfig.topic
      : deleteConfig.content;
  logger.debug(`Ensuring comment "${key}" in #${issueNo} is removed`);

  const comments = await getComments(issueNo);
  let commentId: number | null | undefined = null;

  if (deleteConfig.type === 'by-topic') {
    const byTopic = (comment: GitlabComment): boolean =>
      comment.body.startsWith(`### ${deleteConfig.topic}\n\n`);
    commentId = comments.find(byTopic)?.id;
  } else if (deleteConfig.type === 'by-content') {
    const byContent = (comment: GitlabComment): boolean =>
      comment.body.trim() === deleteConfig.content;
    commentId = comments.find(byContent)?.id;
  }

  if (commentId) {
    await deleteComment(issueNo, commentId);
  }
}

export async function filterUnavailableUsers(
  users: string[],
): Promise<string[]> {
  const filteredUsers: string[] = [];
  for (const user of users) {
    if (!(await isUserBusy(user))) {
      filteredUsers.push(user);
    }
  }
  return filteredUsers;
}

export async function expandGroupMembers(
  reviewersOrAssignees: string[],
): Promise<string[]> {
  const expandedReviewersOrAssignees: string[] = [];
  const normalizedReviewersOrAssigneesWithoutEmails: string[] = [];

  // Skip passing user emails to Gitlab API, but include them in the final result
  for (const reviewerOrAssignee of reviewersOrAssignees) {
    if (reviewerOrAssignee.indexOf('@') > 0) {
      expandedReviewersOrAssignees.push(reviewerOrAssignee);
      continue;
    }

    // Normalize the potential group names before passing to Gitlab API
    normalizedReviewersOrAssigneesWithoutEmails.push(
      noLeadingAtSymbol(reviewerOrAssignee),
    );
  }

  for (const reviewerOrAssignee of normalizedReviewersOrAssigneesWithoutEmails) {
    try {
      const members = await getMemberUsernames(reviewerOrAssignee);
      expandedReviewersOrAssignees.push(...members);
    } catch (err) {
      if (err.statusCode !== 404) {
        logger.debug({ err, reviewerOrAssignee }, 'Unable to fetch group');
      }
      expandedReviewersOrAssignees.push(reviewerOrAssignee);
    }
  }
  return expandedReviewersOrAssignees;
}
