import { type ReactNode, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Search,
  X,
  Filter,
  Network,
  LayoutGrid,
  Orbit,
  Eye,
  EyeOff,
  Map as MapIcon,
  BarChart3,
} from 'lucide-react';
import { type LayoutMode } from './graphTypes';

export interface GraphToolbarProps {
  title: string | undefined;
  headerLeading: ReactNode;
  layoutMode: LayoutMode;
  onLayoutModeChange: (mode: LayoutMode) => void;
  showFilters: boolean;
  onToggleFilters: () => void;
  typeFilterCount: number;
  showClusters: boolean;
  onToggleClusters: () => void;
  showMinimap: boolean;
  onToggleMinimap: () => void;
  showStats: boolean;
  onToggleStats: () => void;
  search: string;
  onSearchChange: (value: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
}

export function GraphToolbar({
  title,
  headerLeading,
  layoutMode,
  onLayoutModeChange,
  showFilters,
  onToggleFilters,
  typeFilterCount,
  showClusters,
  onToggleClusters,
  showMinimap,
  onToggleMinimap,
  showStats,
  onToggleStats,
  search,
  onSearchChange,
  searchRef,
}: GraphToolbarProps) {
  return (
    <div className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-4 py-1 border-b bg-background/95 backdrop-blur-sm shrink-0 z-10 min-w-0 overflow-x-auto">
      {/* Title */}
      <div className="flex items-center gap-2 mr-1 sm:mr-2 shrink-0">
        <div className="hidden lg:flex h-6 w-6 items-center justify-center rounded-lg bg-primary/10">
          <Network className="h-3.5 w-3.5 text-primary" />
        </div>
        <h2 className="text-xs sm:text-sm font-semibold leading-none">
          {title || 'Knowledge graph'}
        </h2>
      </div>

      {/* Layout mode toggle */}
      <div className="flex items-center rounded-md border bg-muted/30 p-0.5 shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => onLayoutModeChange('force')}
              aria-label="Force-directed layout"
              className={cn(
                'flex items-center gap-1 rounded-sm px-1.5 sm:px-2 py-1 text-[10px] font-medium transition-all',
                layoutMode === 'force'
                  ? 'bg-background shadow-sm text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Orbit className="h-3 w-3" />
              <span className="hidden sm:inline">Force</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>Force-directed layout (1)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => onLayoutModeChange('hierarchical')}
              aria-label="Hierarchical layout"
              className={cn(
                'flex items-center gap-1 rounded-sm px-1.5 sm:px-2 py-1 text-[10px] font-medium transition-all',
                layoutMode === 'hierarchical'
                  ? 'bg-background shadow-sm text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <LayoutGrid className="h-3 w-3" />
              <span className="hidden sm:inline">Hierarchy</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>Hierarchical layout (2)</TooltipContent>
        </Tooltip>
      </div>

      {/* Intent-specific layer toggle (or other header slot content) */}
      {headerLeading}

      {/* Filter toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={showFilters ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 gap-1 text-xs shrink-0 px-2 sm:px-3"
            onClick={onToggleFilters}
            aria-label="Toggle type filters"
          >
            <Filter className="h-3 w-3" />
            <span className="hidden sm:inline">Filters</span>
            {typeFilterCount > 0 && (
              <Badge variant="default" className="h-4 px-1 text-[9px] ml-0.5">
                {typeFilterCount}
              </Badge>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Toggle type filters</TooltipContent>
      </Tooltip>

      <div className="flex-1 min-w-0" />

      {/* View toggles */}
      <div className="flex items-center gap-0.5 shrink-0 mr-0.5 sm:mr-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={showClusters ? 'secondary' : 'ghost'}
              size="icon"
              className="h-7 w-7"
              onClick={onToggleClusters}
              aria-label="Toggle clusters"
            >
              {showClusters ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle clusters (c)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={showMinimap ? 'secondary' : 'ghost'}
              size="icon"
              className="h-7 w-7"
              onClick={onToggleMinimap}
              aria-label="Toggle minimap"
            >
              <MapIcon className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle minimap (m)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={showStats ? 'secondary' : 'ghost'}
              size="icon"
              className="h-7 w-7"
              onClick={onToggleStats}
              aria-label="Graph statistics"
            >
              <BarChart3 className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Graph statistics (s)</TooltipContent>
        </Tooltip>
      </div>

      {/* Search */}
      <div className="relative min-w-0 shrink-0">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
        <Input
          ref={searchRef}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search... (f)"
          aria-label="Search nodes"
          className="h-7 w-24 sm:w-32 lg:w-48 pl-7 text-xs"
        />
        {search && (
          <button
            onClick={() => onSearchChange('')}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}
