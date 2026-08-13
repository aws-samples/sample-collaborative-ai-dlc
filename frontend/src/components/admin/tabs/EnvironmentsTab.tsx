import { Boxes, ShieldAlert, Wrench } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EnvironmentRegistry } from './EnvironmentRegistry';
import { EnvironmentResetPanel } from './EnvironmentResetPanel';
import { ToolsRegistry } from './ToolsRegistry';

export function EnvironmentsTab() {
  return (
    <Tabs defaultValue="environments">
      <TabsList className="mb-5">
        <TabsTrigger value="environments" className="gap-1.5">
          <Boxes className="h-3.5 w-3.5" />
          Environments
        </TabsTrigger>
        <TabsTrigger value="tools" className="gap-1.5">
          <Wrench className="h-3.5 w-3.5" />
          Tools
        </TabsTrigger>
        <TabsTrigger value="reset" className="gap-1.5">
          <ShieldAlert className="h-3.5 w-3.5" />
          Reset
        </TabsTrigger>
      </TabsList>
      <TabsContent value="environments">
        <EnvironmentRegistry />
      </TabsContent>
      <TabsContent value="tools">
        <ToolsRegistry />
      </TabsContent>
      <TabsContent value="reset">
        <EnvironmentResetPanel />
      </TabsContent>
    </Tabs>
  );
}
