'use client';

import { normalizeTagName, TAG_NAME_MAX, type BusinessObjectType } from '@crm/core';
import { Card, CardBody, CardHeader, Input, TagChip } from '@crm/ui';
import { useId, useMemo, useRef, useState } from 'react';
import { useTags } from '../lib/bulk';
import { t } from '../lib/i18n';
import { skippedReason, useChangeRecordTags, type RecordTag } from '../lib/tags';

/**
 * The tags on a list row: chips, at most a few, and "+N" for the rest. Read-only.
 *
 * Nothing here decides who may see a tag: the API sent only the tags of a record the caller can read.
 */
export function TagList({
  tags,
  max = 3,
}: {
  tags: readonly RecordTag[] | undefined;
  max?: number;
}) {
  if (tags === undefined || tags.length === 0) {
    return <span className="text-muted-foreground">{t('field.empty')}</span>;
  }
  const shown = tags.slice(0, max);
  const hidden = tags.length - shown.length;
  return (
    <ul className="flex flex-wrap items-center gap-1" aria-label={t('tags.label')}>
      {shown.map((tag) => (
        <li key={tag.id} className="max-w-40">
          <TagChip name={tag.name} color={tag.color} />
        </li>
      ))}
      {hidden > 0 ? (
        <li className="text-xs text-muted-foreground">
          {t('tags.more', { count: hidden })}
          <span className="sr-only">
            {': '}
            {tags
              .slice(max)
              .map((tag) => tag.name)
              .join(', ')}
          </span>
        </li>
      ) : null}
    </ul>
  );
}

/**
 * A record's tags, with a box to add one and a cross to remove one (MVP_SPEC M4, ADR-0063).
 *
 * Typing suggests the workspace's existing tags that are not on the record yet; Enter adds the highlighted
 * suggestion, or, with none highlighted, the typed name, which is created if it is new. The server holds
 * the real rules (the 500-tag limit, `update` on the record, the name rules); this only says what it
 * answered. A person who may not change the record gets the server's refusal in words, not a hidden box,
 * because hiding would be cosmetic (CLAUDE.md §9).
 */
export function TagEditor({
  objectType,
  recordId,
  tags,
}: {
  objectType: BusinessObjectType;
  recordId: string;
  tags: readonly RecordTag[];
}) {
  const all = useTags();
  const change = useChangeRecordTags(objectType, recordId);
  const inputId = useId();
  const listId = useId();
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const name = normalizeTagName(draft);
  const onRecord = useMemo(() => new Set(tags.map((tag) => tag.name.toLowerCase())), [tags]);
  const suggestions = useMemo(() => {
    const needle = name.toLowerCase();
    return (all.data?.data ?? [])
      .filter((tag) => !onRecord.has(tag.name.toLowerCase()))
      .filter((tag) => needle.length === 0 || tag.name.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [all.data, name, onRecord]);

  const exactExisting = (all.data?.data ?? []).find(
    (tag) => tag.name.toLowerCase() === name.toLowerCase(),
  );
  // "Create" is offered for a name nobody has; adding one the record already carries says nothing.
  const canCreate =
    name.length > 0 && exactExisting === undefined && !onRecord.has(name.toLowerCase());
  const options = [
    ...suggestions.map((tag) => ({ key: tag.id, label: tag.name, value: tag.name, create: false })),
    ...(canCreate
      ? [{ key: 'create', label: t('tags.create', { name }), value: name, create: true }]
      : []),
  ];

  const run = (action: 'tag_add' | 'tag_remove', tagName: string) => {
    setMessage(null);
    change.mutate(
      { action, name: tagName },
      {
        onSuccess: (result) => {
          const reason = skippedReason(result);
          if (reason === 'not_permitted') setMessage(t('tags.error.notPermitted'));
          else if (reason === 'not_found') setMessage(t('tags.error.notFound'));
        },
        onError: (error) => {
          if (error.status === 403) setMessage(t('tags.error.notPermitted'));
          else setMessage(error.error.details[0]?.message ?? t('tags.error.generic'));
        },
      },
    );
  };

  const add = (tagName: string) => {
    if (tagName.length === 0 || tagName.length > TAG_NAME_MAX) return;
    run('tag_add', tagName);
    setDraft('');
    setActive(-1);
    setOpen(false);
    inputRef.current?.focus();
  };

  return (
    <div className="space-y-2" data-testid="tag-editor">
      {tags.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="tag-empty">
          {t('tags.none')}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('tags.label')}>
          {tags.map((tag) => (
            <li key={tag.id} className="max-w-full">
              <TagChip
                name={tag.name}
                color={tag.color}
                removeLabel={t('tags.remove', { name: tag.name })}
                onRemove={() => run('tag_remove', tag.name)}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="relative max-w-sm">
        <Input
          id={inputId}
          ref={inputRef}
          label={t('tags.add')}
          labelHidden
          type="text"
          role="combobox"
          aria-expanded={open && options.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          maxLength={TAG_NAME_MAX}
          placeholder={t('tags.add.placeholder')}
          value={draft}
          disabled={change.isPending}
          onChange={(event) => {
            setDraft(event.target.value);
            setActive(-1);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
              setActive((index) => (options.length === 0 ? -1 : (index + 1) % options.length));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((index) =>
                options.length === 0 ? -1 : (index - 1 + options.length) % options.length,
              );
            } else if (event.key === 'Escape') {
              setOpen(false);
              setActive(-1);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const chosen = active >= 0 ? options[active] : undefined;
              add(chosen?.value ?? name);
            }
          }}
          data-testid="tag-input"
        />
        {open && options.length > 0 ? (
          <ul
            id={listId}
            role="listbox"
            aria-label={t('tags.suggestions')}
            className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border border-border bg-popover py-1 text-sm text-popover-foreground shadow-md"
          >
            {options.map((option, index) => (
              <li
                key={option.key}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                // `mousedown`, not `click`: the input's blur would close the list before a click lands.
                onMouseDown={(event) => {
                  event.preventDefault();
                  add(option.value);
                }}
                className={
                  index === active
                    ? 'cursor-pointer bg-accent px-3 py-1.5 text-accent-foreground'
                    : 'cursor-pointer px-3 py-1.5 hover:bg-muted'
                }
              >
                {option.label}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <p role="status" aria-live="polite" className="min-h-5 text-sm text-destructive">
        {message}
      </p>
    </div>
  );
}

/** The record page's Tags card: a title and the editor, the same on all four record pages. */
export function TagsCard({
  objectType,
  recordId,
  tags,
}: {
  objectType: BusinessObjectType;
  recordId: string;
  tags: readonly RecordTag[] | undefined;
}) {
  return (
    <Card>
      <CardHeader title={t('tags.label')} />
      <CardBody className="px-5 py-4">
        <TagEditor objectType={objectType} recordId={recordId} tags={tags ?? []} />
      </CardBody>
    </Card>
  );
}
