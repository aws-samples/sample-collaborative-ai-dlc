import { Navigate, useLocation, useParams } from 'react-router';

export default function NewNativeIntentPage() {
  const { projectId = '' } = useParams();
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  query.set('backend', 'native');
  return <Navigate replace to={`/space/${encodeURIComponent(projectId)}/intent/new?${query}`} />;
}
