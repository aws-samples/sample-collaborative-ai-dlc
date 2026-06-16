import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  blocksService,
  BLOCK_TYPES,
  BLOCK_TYPE_LABELS,
  type BlockInput,
  type BlockType,
} from '@/services/blocks';
import { SIMPLE_BLOCK_FORMS } from '@/components/blocks/blockFields';
import { SkillEditor, type SkillForm } from '@/components/blocks/SkillEditor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, AlertCircle, CheckCircle2, X, Lock } from 'lucide-react';

const isBlockType = (v: string | undefined): v is BlockType =>
  !!v && (BLOCK_TYPES as readonly string[]).includes(v);

// kebab-case, matching the backend's id rule.
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export default function BlockEditor() {
  const navigate = useNavigate();
  const { type: typeParam, id } = useParams<{ type: string; id: string }>();
  const blockType: BlockType = isBlockType(typeParam) ? typeParam : 'skill';
  const isNew = id === 'new' || id === undefined;
  const labels = BLOCK_TYPE_LABELS[blockType];
  const isSkill = blockType === 'skill';
  const typeForm = SIMPLE_BLOCK_FORMS[blockType];

  // The whole editable block as a flat form object; type-specific attributes
  // (kind, c1_definition, …) ride along untyped and are sent back verbatim.
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [body, setBody] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const str = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : '');
  const setField = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  const load = useCallback(async () => {
    if (isNew || !id) return;
    setLoading(true);
    try {
      const block = await blocksService.get(blockType, id);
      setReadOnly(block.readOnly);
      setForm(block);
      if (block.hasBody) {
        const { body: text } = await blocksService.getBody(blockType, id);
        setBody(text);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load block');
    } finally {
      setLoading(false);
    }
  }, [blockType, id, isNew]);

  useEffect(() => {
    load();
  }, [load]);

  const buildPayload = (): BlockInput => {
    // Drop server-managed fields; keep intrinsic attributes + name/description.
    const {
      id: _id,
      blockId,
      blockType: _bt,
      tenantId,
      version,
      readOnly: _ro,
      hasBody,
      bodyBytes,
      createdAt,
      updatedAt,
      ...attrs
    } = form;
    void _id;
    void blockId;
    void _bt;
    void tenantId;
    void version;
    void _ro;
    void hasBody;
    void bodyBytes;
    void createdAt;
    void updatedAt;
    return { ...attrs, name: str('name'), body } as BlockInput;
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const name = str('name').trim();
    if (!name) return setError('Name is required.');

    const payload = buildPayload();

    if (isNew) {
      const newId = str('id').trim();
      if (!ID_RE.test(newId)) {
        return setError('Id must be kebab-case (lowercase letters, digits, hyphens).');
      }
      payload.id = newId;
    }

    setSaving(true);
    try {
      if (isNew) {
        await blocksService.create(blockType, payload);
        navigate(`/blocks/${blockType}/${payload.id}`);
      } else {
        await blocksService.update(blockType, id!, payload);
        setSuccess('Saved.');
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save block');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="max-w-3xl mx-auto p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      <form onSubmit={handleSave} className="max-w-3xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => navigate(`/blocks/${blockType}`)}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Button>
          <div className="h-5 w-px bg-border" />
          <h1 className="text-xl font-semibold tracking-tight">
            {isNew ? `New ${labels.singular}` : str('name') || labels.singular}
          </h1>
          {readOnly && (
            <Badge variant="outline" className="gap-1 text-[10px] ml-auto">
              <Lock className="h-2.5 w-2.5" />
              SYSTEM · read-only
            </Badge>
          )}
        </div>

        {readOnly && (
          <p className="text-xs text-muted-foreground">
            This is a shipped baseline block and cannot be edited. Clone it to make changes (coming
            soon).
          </p>
        )}

        {/* Messages */}
        {error && (
          <div className="bg-destructive/5 border border-destructive/20 text-destructive px-4 py-3 rounded-md flex items-start justify-between gap-3 text-sm">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-destructive hover:text-destructive"
              onClick={() => setError(null)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
        {success && (
          <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-400 px-4 py-3 rounded-md flex items-start gap-2 text-sm">
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{success}</span>
          </div>
        )}

        {/* Identity */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Identity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {isNew && (
              <div className="grid gap-2">
                <Label>Id</Label>
                <Input
                  value={str('id')}
                  onChange={(e) => setField('id', e.target.value)}
                  placeholder="kebab-case-id"
                  disabled={readOnly}
                />
                <p className="text-xs text-muted-foreground">
                  Permanent identifier; lowercase letters, digits, hyphens.
                </p>
              </div>
            )}
            <div className="grid gap-2">
              <Label>Name</Label>
              <Input
                value={str('name')}
                onChange={(e) => setField('name', e.target.value)}
                placeholder={`${labels.singular} name`}
                disabled={readOnly}
              />
            </div>
            <div className="grid gap-2">
              <Label>Description</Label>
              <Input
                value={str('description')}
                onChange={(e) => setField('description', e.target.value)}
                placeholder="One-line summary"
                disabled={readOnly}
              />
            </div>
          </CardContent>
        </Card>

        {/* Type-specific: Skill gets the three-compartment editor; the rest get
            the data-driven simple-field form. */}
        {isSkill ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Contract</CardTitle>
            </CardHeader>
            <CardContent>
              <SkillEditor
                value={form as SkillForm}
                onChange={(next) => setForm(next as Record<string, unknown>)}
                disabled={readOnly}
              />
            </CardContent>
          </Card>
        ) : (
          typeForm &&
          typeForm.fields.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {typeForm.fields.map((field) => {
                  const raw =
                    field.kind === 'csv'
                      ? (Array.isArray(form[field.key]) ? (form[field.key] as string[]) : []).join(
                          ', ',
                        )
                      : str(field.key);
                  const onChange = (v: string) =>
                    setField(
                      field.key,
                      field.kind === 'csv'
                        ? v
                            .split(',')
                            .map((x) => x.trim())
                            .filter(Boolean)
                        : v,
                    );
                  return (
                    <div key={field.key} className="grid gap-2">
                      <Label>{field.label}</Label>
                      {field.kind === 'textarea' ? (
                        <Textarea
                          value={raw}
                          onChange={(e) => onChange(e.target.value)}
                          placeholder={field.placeholder}
                          disabled={readOnly}
                        />
                      ) : (
                        <Input
                          value={raw}
                          onChange={(e) => onChange(e.target.value)}
                          placeholder={field.placeholder}
                          disabled={readOnly}
                        />
                      )}
                      {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )
        )}

        {/* Body — markdown instructions / prose, stored in S3. */}
        {(isSkill || typeForm?.bodyLabel) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">
                {isSkill ? 'Instructions' : typeForm!.bodyLabel}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Markdown…"
                className="min-h-[200px] font-mono text-xs"
                disabled={readOnly}
              />
              {!isSkill && typeForm?.bodyHelp && (
                <p className="text-xs text-muted-foreground">{typeForm.bodyHelp}</p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Actions */}
        {!readOnly && (
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate(`/blocks/${blockType}`)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : isNew ? `Create ${labels.singular}` : 'Save'}
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}
