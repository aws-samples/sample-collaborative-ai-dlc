import { Card, CardContent } from '@/components/ui/card';
import { Keyboard, X } from 'lucide-react';

export interface GraphKeyboardHelpProps {
  onClose: () => void;
}

export function GraphKeyboardHelp({ onClose }: GraphKeyboardHelpProps) {
  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20">
      <Card className="bg-background/95 backdrop-blur-sm shadow-xl">
        <div className="px-4 py-2 border-b flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Keyboard className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold">Keyboard Shortcuts</span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <CardContent className="p-3">
          <div className="grid grid-cols-2 gap-x-8 gap-y-1">
            {[
              ['f or /', 'Search nodes'],
              ['1', 'Force layout'],
              ['2', 'Hierarchical layout'],
              ['c', 'Toggle clusters'],
              ['m', 'Toggle minimap'],
              ['s', 'Toggle statistics'],
              ['+ / -', 'Zoom in / out'],
              ['0', 'Fit to content'],
              ['Esc', 'Clear selection'],
              ['?', 'This help'],
            ].map(([key, desc]) => (
              <div key={key} className="flex items-center gap-2 py-0.5">
                <kbd className="inline-flex h-5 items-center rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground min-w-[28px] justify-center">
                  {key}
                </kbd>
                <span className="text-[11px] text-muted-foreground">{desc}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
