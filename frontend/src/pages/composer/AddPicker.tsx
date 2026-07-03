import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus } from 'lucide-react';

interface AddPickerProps {
  placeholder: string;
  options: { id: string; label: string }[];
  onAdd: (id: string) => void;
}

export function AddPicker({ placeholder, options, onAdd }: AddPickerProps) {
  const [selected, setSelected] = useState('');
  return (
    <div className="flex items-center gap-2 pt-1">
      <Select value={selected} onValueChange={setSelected}>
        <SelectTrigger className="h-9 flex-1 text-sm">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5"
        disabled={!selected}
        onClick={() => {
          if (selected) {
            onAdd(selected);
            setSelected('');
          }
        }}
      >
        <Plus className="h-3.5 w-3.5" />
        Add
      </Button>
    </div>
  );
}
