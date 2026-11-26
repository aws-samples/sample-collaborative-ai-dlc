import { useState, useEffect, useMemo } from 'react';
import {
  getGitProviderService,
  githubAppService,
  repoDisplayName,
  type GitProvider,
  type GitRepo,
} from '../services/gitProvider';
import { MAX_LIST_ROWS, readListPages } from '../services/pagination';

// Where the repo list comes from: 'oauth' (default) lists the caller's own
// repos via their personal connection; 'github-app' lists repos across the
// platform App's installations — no personal connection needed. Every other
// provider, CodeCommit included, uses the default per-provider listRepos path.
type RepoSource = 'oauth' | 'github-app';

// GitLab ignores shorter search terms.
const MIN_SERVER_SEARCH_LENGTH = 3;
const SERVER_SEARCH_DEBOUNCE_MS = 300;

interface BaseProps {
  provider: GitProvider;
  instance?: string;
  exclude?: string[];
  repoSource?: RepoSource;
}

interface SingleProps extends BaseProps {
  multiple?: false;
  value: string;
  onChange: (repo: GitRepo | null) => void;
}

interface MultiProps extends BaseProps {
  multiple: true;
  value: string[];
  onChange: (repos: GitRepo[]) => void;
}

export type GitRepoSelectProps = SingleProps | MultiProps;

// Appends the repos not already listed, keeping earlier selections resolvable.
const mergeRepos = (current: GitRepo[], more: GitRepo[]) => {
  const known = new Set(current.map((r) => r.id));
  const added = more.filter((r) => !known.has(r.id));
  return added.length ? [...current, ...added] : current;
};

export function GitRepoSelect(props: GitRepoSelectProps) {
  const { provider, instance } = props;
  const service = useMemo(() => getGitProviderService(provider, instance), [provider, instance]);
  const repoSource = props.repoSource ?? 'oauth';

  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  // Why the list stopped short: the page cap, or a page after the first failed.
  const [incomplete, setIncomplete] = useState<'capped' | 'failed' | null>(null);

  useEffect(() => {
    let cancelled = false;
    const listReposPage = repoSource === 'oauth' ? service.listReposPage : undefined;
    setFetching(true);
    setError(null);
    setIncomplete(null);
    setLoadingMore(false);
    if (!listReposPage) {
      const listRepos =
        repoSource === 'github-app' ? githubAppService.listRepos : service.listRepos;
      listRepos()
        .then((rows) => {
          if (!cancelled) setRepos(rows);
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        })
        .finally(() => {
          if (!cancelled) setFetching(false);
        });
      return () => {
        cancelled = true;
      };
    }
    // One request per page: the list shows after page 1 and grows as the
    // next pages arrive.
    void (async () => {
      let pagesRead = 0;
      let done = false;
      try {
        const pages = readListPages((page) =>
          listReposPage(page).then((r) =>
            // A server that predates paging answers with the bare first page.
            Array.isArray(r) ? { rows: r } : { rows: r.repos, nextPage: r.nextPage },
          ),
        );
        for await (const page of pages) {
          if (cancelled) return;
          // sort=updated: a repo updated while the pages are read moves to
          // page 1, so it can be listed twice (merged once here) or, if it
          // moved from a page not yet read, missed until the picker reopens.
          const { rows } = page;
          const firstPage = pagesRead === 0;
          setRepos((current) => (firstPage ? rows : mergeRepos(current, rows)));
          pagesRead += 1;
          done = page.done;
          setFetching(false);
          setLoadingMore(!done);
        }
        if (!cancelled && !done) setIncomplete('capped');
      } catch (e) {
        if (cancelled) return;
        if (pagesRead === 0)
          setError(e instanceof Error ? e.message : 'Failed to load repositories');
        else setIncomplete('failed');
      } finally {
        if (!cancelled) {
          setFetching(false);
          setLoadingMore(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [service, repoSource]);

  // Providers that cap the unfiltered list (GitLab: large group trees exceed
  // it) expose `searchRepos`; a typed search is sent there and the matches are
  // merged into the list. Merging, rather than replacing, keeps earlier
  // selections resolvable.
  const searchRepos = repoSource === 'oauth' ? service.searchRepos : undefined;
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const term = search.trim();
    if (!searchRepos || term.length < MIN_SERVER_SEARCH_LENGTH) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      searchRepos(term)
        .then((matches) => {
          if (cancelled) return;
          setRepos((current) => mergeRepos(current, matches));
        })
        // The unfiltered list is still usable, so a failed search is not fatal.
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SERVER_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setSearching(false);
    };
  }, [search, searchRepos]);

  const excludeSet = useMemo(() => new Set(props.exclude ?? []), [props.exclude]);

  const filtered = useMemo(() => {
    const available = repos.filter((r) => !excludeSet.has(r.fullName));
    // Every word must appear, so "emu steering" matches ".../emu/utilities/
    // steering-docs" the same way GitLab's namespace search does.
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return available;
    return available.filter((r) => {
      const names = `${r.fullName} ${repoDisplayName(provider, r.fullName)}`.toLowerCase();
      return words.every((w) => names.includes(w));
    });
  }, [repos, excludeSet, search, provider]);

  if (fetching) return <div className="text-sm text-gray-500">Loading repositories...</div>;
  if (error) return <div className="text-sm text-red-600">{error}</div>;

  // CodeCommit has no self-service way to widen access from here; when the role
  // sees nothing, point the user at their AWS admin (works for the tag and the
  // explicit-ARN list alike).
  const emptyHint =
    provider === 'codecommit' ? (
      <p className="px-3 pb-4 text-center text-xs text-gray-500">
        Ask your AWS admin to grant the platform role access to the repositories you need.
      </p>
    ) : null;

  if (props.multiple) {
    const selected = new Set(props.value);

    const toggle = (repo: GitRepo) => {
      const next = selected.has(repo.fullName)
        ? props.value.filter((v) => v !== repo.fullName)
        : [...props.value, repo.fullName];
      props.onChange(
        next
          .map((fn) => repos.find((r) => r.fullName === fn))
          .filter((r): r is GitRepo => r !== undefined),
      );
    };

    return (
      <div className="space-y-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search repositories..."
          className="w-full border dark:border-gray-600 rounded px-3 py-2 text-sm dark:bg-gray-700 dark:text-white"
        />
        <div className="max-h-60 overflow-y-auto border dark:border-gray-600 rounded divide-y dark:divide-gray-600">
          {filtered.length === 0 ? (
            <div role="status" className="px-3 py-4 text-center text-sm text-gray-500">
              {searching
                ? 'Searching...'
                : loadingMore
                  ? 'Loading more repositories...'
                  : repos.length === 0
                    ? 'No repositories available'
                    : 'No matching repositories'}
              {!searching && repos.length === 0 && emptyHint}
            </div>
          ) : (
            filtered.map((repo) => (
              <label
                key={repo.id}
                className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selected.has(repo.fullName)}
                  onChange={() => toggle(repo)}
                  className="rounded border-gray-300"
                />
                <span className="text-sm flex-1 min-w-0 wrap-anywhere" title={repo.fullName}>
                  {repoDisplayName(provider, repo.fullName)}
                </span>
                {repo.private && <span className="text-xs text-gray-400">🔒</span>}
              </label>
            ))
          )}
        </div>
        {loadingMore && filtered.length > 0 && (
          <p role="status" className="text-xs text-gray-500">
            Loading more repositories...
          </p>
        )}
        {incomplete === 'capped' && (
          <p role="status" className="text-xs text-gray-500">
            Showing the {MAX_LIST_ROWS.toLocaleString('en-US')} most recently updated repositories.
          </p>
        )}
        {incomplete === 'failed' && (
          <p role="alert" className="text-xs text-amber-600">
            Some repositories could not be loaded. Reopen the picker to try again.
          </p>
        )}
        {selected.size > 0 && <p className="text-xs text-gray-500">{selected.size} selected</p>}
      </div>
    );
  }

  return (
    <select
      value={props.value}
      onChange={(e) => {
        const repo = repos.find((r) => r.fullName === e.target.value) || null;
        props.onChange(repo);
      }}
      className="w-full border dark:border-gray-600 rounded px-3 py-2 dark:bg-gray-700 dark:text-white"
    >
      <option value="">Select a repository</option>
      {filtered.map((repo) => (
        <option key={repo.id} value={repo.fullName}>
          {repoDisplayName(provider, repo.fullName)} {repo.private && '🔒'}
        </option>
      ))}
    </select>
  );
}
