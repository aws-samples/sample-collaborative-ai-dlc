import { Outlet, useParams } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppSidebar } from '@/components/layout/AppSidebar'
import { AppHeader } from '@/components/layout/AppHeader'
import { ActivityPanel } from '@/components/layout/ActivityPanel'
import { StatusBar } from '@/components/layout/StatusBar'
import { CommandPalette } from '@/components/layout/CommandPalette'
import { useState, useCallback } from 'react'

export function AppShell() {
  const { sprintId } = useParams<{ sprintId: string }>()
  const inSprint = !!sprintId

  const [activityPanelOpen, setActivityPanelOpen] = useState(true)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)

  // Only show panels when inside a sprint
  const showSidebar = inSprint && !sidebarCollapsed
  const showActivity = inSprint && activityPanelOpen

  const toggleSidebar = useCallback(() => setSidebarCollapsed(prev => !prev), [])
  const toggleActivity = useCallback(() => setActivityPanelOpen(prev => !prev), [])

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen flex-col bg-background">
        {/* Header */}
        <AppHeader
          onToggleSidebar={toggleSidebar}
          onToggleActivity={toggleActivity}
          onOpenCommand={() => setCommandOpen(true)}
          sidebarCollapsed={sidebarCollapsed}
          activityPanelOpen={activityPanelOpen}
          inSprint={inSprint}
        />

        {/* Main content area */}
        <div
          className="flex-1 overflow-hidden grid"
          style={{
            gridTemplateColumns: [
              showSidebar ? 'minmax(240px, 280px)' : '',
              '1fr',
              showActivity ? 'minmax(280px, 360px)' : '',
            ].filter(Boolean).join(' '),
          }}
        >
          {/* Sidebar - only in sprint views */}
          {showSidebar && (
            <aside className="hidden md:flex border-r overflow-hidden">
              <AppSidebar />
            </aside>
          )}

          {/* Main content */}
          <main className="h-full overflow-y-auto min-w-0">
            <Outlet />
          </main>

          {/* Activity panel - only in sprint views */}
          {showActivity && (
            <aside className="hidden lg:flex overflow-hidden">
              <ActivityPanel sprintId={sprintId} onClose={() => setActivityPanelOpen(false)} />
            </aside>
          )}
        </div>

        {/* Status bar */}
        <StatusBar />

        {/* Command palette */}
        <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
      </div>
    </TooltipProvider>
  )
}
