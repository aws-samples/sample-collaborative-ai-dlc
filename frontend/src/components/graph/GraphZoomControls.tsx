import { Plus, Minus, Maximize2 } from 'lucide-react';
import { type ViewBox, widthToSliderT, sliderTToWidth } from './graphTypes';

export interface GraphZoomControlsProps {
  viewBox: ViewBox;
  onViewBoxChange: (vb: ViewBox) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToContent: () => void;
}

export function GraphZoomControls({
  viewBox,
  onViewBoxChange,
  onZoomIn,
  onZoomOut,
  onFitToContent,
}: GraphZoomControlsProps) {
  return (
    <div className="absolute bottom-[160px] right-3 z-10 flex flex-col items-center gap-1.5 rounded-xl bg-background/90 backdrop-blur-sm border shadow-md px-2 py-2.5">
      <button
        onClick={onZoomIn}
        aria-label="Zoom in"
        className="flex h-8 w-8 items-center justify-center rounded-lg border bg-background text-foreground/80 shadow-sm hover:bg-muted hover:text-foreground active:scale-95 transition-all focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Plus className="h-4 w-4" />
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.005}
        value={widthToSliderT(viewBox.width)}
        onChange={(e) => {
          const t = parseFloat(e.target.value);
          const newW = sliderTToWidth(t);
          const aspect = viewBox.height / viewBox.width;
          const newH = newW * aspect;
          const cx = viewBox.x + viewBox.width / 2;
          const cy = viewBox.y + viewBox.height / 2;
          onViewBoxChange({ x: cx - newW / 2, y: cy - newH / 2, width: newW, height: newH });
        }}
        aria-label="Zoom level"
        title="Zoom level"
        className="h-28 w-5 appearance-none bg-transparent cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [writing-mode:vertical-lr] [direction:rtl] [&::-webkit-slider-runnable-track]:w-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-muted [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground/70 [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-background [&::-webkit-slider-thumb]:shadow-md [&::-moz-range-track]:w-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-muted [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-foreground/70 [&::-moz-range-thumb]:border-0"
      />
      <button
        onClick={onZoomOut}
        aria-label="Zoom out"
        className="flex h-8 w-8 items-center justify-center rounded-lg border bg-background text-foreground/80 shadow-sm hover:bg-muted hover:text-foreground active:scale-95 transition-all focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Minus className="h-4 w-4" />
      </button>
      <div className="w-full border-t my-0.5" />
      <button
        onClick={onFitToContent}
        aria-label="Fit to content"
        className="flex h-8 w-8 items-center justify-center rounded-lg border bg-background text-foreground/80 shadow-sm hover:bg-muted hover:text-foreground active:scale-95 transition-all focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Maximize2 className="h-4 w-4" />
      </button>
    </div>
  );
}
