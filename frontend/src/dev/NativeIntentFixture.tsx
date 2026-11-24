import { IntentSectionTabs } from '@/components/layout/IntentSectionTabs';
import { detectSection } from '@/components/layout/IntentPipelineBar';
import { useLocation, useNavigate, useParams } from 'react-router';
import { currentSessionEpoch } from '@/services/sessionExpiry';
import { useNativeListingVersion } from '@/hooks/useNativeIntents';
import { useNativeIntentAdapter } from '@/contexts/adapters/nativeIntent';
import { NativeIntentWorkspace } from '@/components/intent/NativeIntentWorkspace';

// Isolated fixture entry. The application supplies the same adapter through IntentProvider.
export default function NativeIntentFixture() {
  const { projectId = '', intentId = '' } = useParams();
  useNativeListingVersion();
  return (
    <NativeWorkspace
      key={JSON.stringify([projectId, intentId, currentSessionEpoch()])}
      projectId={projectId}
      intentId={intentId}
    />
  );
}

function NativeWorkspace({ projectId, intentId }: { projectId: string; intentId: string }) {
  const adapter = useNativeIntentAdapter(projectId, intentId);
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      {adapter.intent && (
        <IntentSectionTabs
          projectId={projectId}
          intentId={intentId}
          backend="native"
          currentSection={detectSection(location.pathname)}
          onNavigate={navigate}
        />
      )}
      <NativeIntentWorkspace adapter={adapter} />
    </>
  );
}
