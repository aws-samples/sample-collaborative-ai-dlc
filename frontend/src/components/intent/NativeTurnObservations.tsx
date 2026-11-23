import type { NativeActivityEvent } from '@/services/nativeIntents';

export function NativeTurnObservations({
  events,
  attemptId,
  sequence,
  publicationId,
  displayedAt,
}: {
  events?: NativeActivityEvent[];
  attemptId: string;
  sequence: number;
  publicationId?: string;
  displayedAt?: number;
}) {
  const turn =
    events?.filter((event) => event.attemptId === attemptId && event.turnSequence === sequence) ??
    [];
  const publication = turn.find(
    (event) => event.type === 'native.published' && event.publicationId === publicationId,
  );
  // A revision is identified by both its immutable id and its sequence.
  const facts = publicationId
    ? publication
      ? turn.filter((event) => event.revision <= publication.revision)
      : []
    : turn;
  const answer =
    publication &&
    events?.find(
      (event) =>
        event.attemptId === attemptId &&
        event.turnSequence === sequence + 1 &&
        event.replyToPublicationId === publicationId,
    );
  const publishedAt = publication && Date.parse(publication.timestamp);
  return (
    <details className="space-y-2 text-sm">
      <summary>
        Turn {sequence} observations{publicationId ? ` · Publication ${publicationId}` : ''}
      </summary>
      <p>Attempt {attemptId}</p>
      {facts.length ? (
        <ul>
          {facts.map((event) => (
            <li key={event.eventId}>
              <time dateTime={event.timestamp}>{event.timestamp}</time> · {event.summary}
            </li>
          ))}
        </ul>
      ) : (
        <p>Scoped lifecycle measurements unavailable.</p>
      )}
      {publicationId && (
        <>
          <p>
            Member wait from publication to accepted reply:{' '}
            {publishedAt !== undefined &&
            answer?.acceptedAt !== undefined &&
            answer.acceptedAt >= publishedAt
              ? `${answer.acceptedAt - publishedAt} ms`
              : 'unavailable'}
          </p>
          <p>
            Publication to first visible display in this open Current view:{' '}
            {displayedAt !== undefined && publishedAt !== undefined && displayedAt >= publishedAt
              ? `approximately ${displayedAt - publishedAt} ms (controller commit to browser display, subject to clock skew)`
              : 'unavailable'}
          </p>
        </>
      )}
    </details>
  );
}
