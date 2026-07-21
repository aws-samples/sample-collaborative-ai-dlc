import { useState, useEffect, useMemo } from 'react';
import { type GitProvider, type GitFile, type GitFileContent } from '../services/gitProvider';
import { sourceControlService } from '../services/sourceControl';
// PrismAsyncLight instead of the full Prism build: the full build statically
// bundles every refractor language grammar (~570 kB minified — it was the
// single largest item in the app bundle). The async-light build ships with no
// grammars and lazy-loads each language chunk on first use.
import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { TreeView, type TreeDataItem } from './ui/tree-view';
import { Folder, File } from 'lucide-react';

// Map a file extension to a syntax-highlighter language id.
const getLanguage = (path: string) => {
  const ext = path.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'jsx',
    ts: 'typescript',
    tsx: 'tsx',
    py: 'python',
    rb: 'ruby',
    java: 'java',
    go: 'go',
    rs: 'rust',
    cpp: 'cpp',
    c: 'c',
    cs: 'csharp',
    php: 'php',
    // Prism's language id for HTML is `markup` (`html` is not a loadable id
    // in the async-light build — it would silently fall back to plain text).
    html: 'markup',
    css: 'css',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    sh: 'bash',
  };
  return langMap[ext || ''] || 'text';
};

interface GitFileBrowserProps {
  projectId: string;
  provider: GitProvider;
  // Canonical repo reference (owner/repo for GitHub, group/project for GitLab).
  repoId: string;
  branch?: string;
}

export function GitFileBrowser({
  projectId,
  provider,
  repoId,
  branch = 'main',
}: GitFileBrowserProps) {
  const [files, setFiles] = useState<GitFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<GitFileContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingContent, setLoadingContent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  // Reload the file list when the provider/repo/branch changes. loadFiles closes
  // over exactly those, so the dep array is complete; the function itself is
  // intentionally omitted (defined below, single call site).
  useEffect(() => {
    loadFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, repoId, branch]);

  const loadFiles = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await sourceControlService.getTree(projectId, provider, repoId, branch);
      setFiles(data.tree);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load files');
    } finally {
      setLoading(false);
    }
  };

  const loadFileContent = async (path: string) => {
    try {
      setLoadingContent(true);
      const content = await sourceControlService.getFileContents(
        projectId,
        provider,
        repoId,
        path,
        branch,
      );
      setSelectedFile(content);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load file content');
    } finally {
      setLoadingContent(false);
    }
  };

  const filteredFiles = files.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase()));

  const treeData = useMemo(() => {
    const source = filter ? filteredFiles : files;
    const root: TreeDataItem[] = [];
    const folders = new Map<string, TreeDataItem>();

    const getOrCreateFolder = (path: string): TreeDataItem => {
      if (folders.has(path)) return folders.get(path)!;
      const name = path.split('/').pop()!;
      const parentPath = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : null;
      const folder: TreeDataItem = {
        id: `folder:${path}`,
        name,
        icon: Folder,
        openIcon: Folder,
        children: [],
      };
      folders.set(path, folder);
      if (parentPath) {
        getOrCreateFolder(parentPath).children!.push(folder);
      } else {
        root.push(folder);
      }
      return folder;
    };

    for (const file of source) {
      const lastSlash = file.path.lastIndexOf('/');
      const name = lastSlash >= 0 ? file.path.substring(lastSlash + 1) : file.path;
      const item: TreeDataItem = {
        id: file.path,
        name,
        icon: File,
        onClick: () => loadFileContent(file.path),
      };
      if (lastSlash >= 0) {
        getOrCreateFolder(file.path.substring(0, lastSlash)).children!.push(item);
      } else {
        root.push(item);
      }
    }
    return root;
    // loadFileContent is only referenced inside an onClick closure; it need not
    // retrigger the tree rebuild, so it is intentionally omitted from the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, filter, filteredFiles]);

  if (loading) {
    return (
      <div className="text-center py-8 text-muted-foreground">Loading repository files...</div>
    );
  }

  if (error) {
    return <div className="text-center py-8 text-destructive">{error}</div>;
  }

  return (
    <div className="grid grid-cols-3 gap-4 h-[600px]">
      {/* File List */}
      <div className="col-span-1 border border-border rounded-lg overflow-hidden flex flex-col">
        <div className="p-3 border-b border-border bg-muted">
          <input
            type="text"
            placeholder="Filter files..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full px-3 py-1.5 text-sm border border-border rounded bg-background text-foreground focus:ring-2 focus:ring-primary"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {treeData.length === 0 ? (
            <p className="text-center py-4 text-muted-foreground text-sm">No files found</p>
          ) : (
            <TreeView
              data={treeData}
              defaultNodeIcon={Folder}
              defaultLeafIcon={File}
              onSelectChange={(item) => {
                if (item && !item.children) loadFileContent(item.id);
              }}
            />
          )}
        </div>
      </div>

      {/* File Content */}
      <div className="col-span-2 border border-border rounded-lg overflow-hidden flex flex-col">
        {loadingContent ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            Loading file content...
          </div>
        ) : selectedFile ? (
          <>
            <div className="p-3 border-b border-border bg-muted flex justify-between items-center">
              <span className="text-sm font-medium text-foreground">{selectedFile.path}</span>
              <button
                onClick={() => setSelectedFile(null)}
                className="text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-auto">
              <SyntaxHighlighter
                language={getLanguage(selectedFile.path)}
                style={vscDarkPlus}
                showLineNumbers
                customStyle={{ margin: 0, fontSize: '12px' }}
              >
                {selectedFile.content}
              </SyntaxHighlighter>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            Select a file to view its contents
          </div>
        )}
      </div>
    </div>
  );
}
