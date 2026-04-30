import type { CodeFile } from '../services/codeFiles';

interface Props {
  codeFile: CodeFile;
}

export default function CodeFileViewer({ codeFile }: Props) {
  return (
    <div className="py-1.5 px-2 border rounded">
      <div className="flex justify-between items-start">
        <h4 className="font-mono text-xs font-medium">{codeFile.filePath}</h4>
        {codeFile.commitRef && <span className="px-1.5 py-0.5 text-[10px] bg-muted text-muted-foreground rounded font-mono">{codeFile.commitRef.slice(0, 7)}</span>}
      </div>
      {codeFile.summary && <p className="text-xs text-muted-foreground mt-0.5">{codeFile.summary}</p>}
    </div>
  );
}
