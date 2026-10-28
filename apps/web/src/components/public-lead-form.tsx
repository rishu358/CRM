'use client';

import { HONEYPOT_FIELD } from '@crm/core';
import type { PublicFormDefinition } from '@crm/contracts';
import { Button, Checkbox } from '@crm/ui';
import { useRef, useState, type FormEvent } from 'react';
import { api, type ApiRequestError } from '../lib/api-client';
import { t, type TranslationKey } from '../lib/i18n';
import { LeadFormFields, toBodyValue, type FieldValue, type FieldValues } from './lead-form-fields';

/**
 * The hosted website lead form, as a visitor sees it (ADR-0063 5.1).
 *
 * A page on its own, with no app frame and no session: the visitor is a stranger on a company's
 * website. It talks to the one API every client uses, through this app's `/api/proxy`, which sends
 * no credential for these routes. What it sends is the form's own fields, the consent, the fill
 * token from the definition, a hidden trap field a person never sees, and one `Idempotency-Key` per
 * page load so a double click or a retry makes one lead.
 *
 * When the page is the whole window and the company named a page to go to, the visitor is sent
 * there; inside someone else's page (an iframe) the message is shown instead, and the page never
 * navigates its parent.
 */

type Phase = 'filling' | 'sending' | 'done';

function newKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `page-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const SERVER_WORDS = ['Required', 'Not valid', 'Too long'] as const;

export function PublicLeadForm({ formKey, form }: { formKey: string; form: PublicFormDefinition }) {
  const [values, setValues] = useState<FieldValues>({});
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ text: string; reload: boolean } | null>(null);
  const [phase, setPhase] = useState<Phase>('filling');
  const idempotencyKey = useRef<string | null>(null);
  const trap = useRef<HTMLInputElement>(null);

  const set = (key: string, value: FieldValue) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (current[key] === undefined) return current;
      const { [key]: _removed, ...rest } = current;
      return rest;
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (phase === 'sending') return;

    // Mirrors what the server will check, so a person is told before the round trip. The server
    // checks all of it again and its answer is the one that counts.
    const local: Record<string, string> = {};
    for (const field of form.fields) {
      const body = toBodyValue(field, values[field.key]);
      if (field.required && (body === undefined || body === false)) {
        local[field.key] = t('publicForm.required');
      }
    }
    if (!consent) local['consent'] = t('publicForm.consentRequired');
    setErrors(local);
    if (Object.keys(local).length > 0) return;

    const body: Record<string, unknown> = {
      consent: true,
      fillToken: form.fillToken,
      [HONEYPOT_FIELD]: trap.current?.value ?? '',
    };
    for (const field of form.fields) {
      const value = toBodyValue(field, values[field.key]);
      if (value !== undefined) body[field.key] = value;
    }

    setPhase('sending');
    setNotice(null);
    idempotencyKey.current ??= newKey();
    try {
      await api.post(`/public/forms/${formKey}/submissions`, body, {
        'Idempotency-Key': idempotencyKey.current,
      });
      setPhase('done');
      const framed = window.self !== window.top;
      if (!framed && form.successRedirectUrl !== null) {
        window.location.assign(form.successRedirectUrl);
      }
    } catch (error) {
      setPhase('filling');
      const failure = error as ApiRequestError;
      if (failure.code === 'FORM_EXPIRED') {
        setNotice({ text: t('publicForm.expired'), reload: true });
      } else if (failure.status === 429) {
        setNotice({ text: t('publicForm.tooMany'), reload: false });
      } else if (failure.status === 422) {
        const fields: Record<string, string> = {};
        for (const detail of failure.error.details) {
          const word = SERVER_WORDS.find((candidate) => candidate === detail.message);
          fields[detail.path === undefined || detail.path === '' ? '_form' : detail.path] = t(
            `publicForm.fieldError.${word ?? 'Not valid'}` as TranslationKey,
          );
        }
        setErrors(fields);
        setNotice({ text: t('publicForm.problems'), reload: false });
      } else {
        setNotice({ text: t('publicForm.failed'), reload: false });
      }
    }
  };

  if (phase === 'done') {
    return (
      <main className="mx-auto max-w-xl px-4 py-8">
        <h1 className="text-lg font-semibold">{t('publicForm.done')}</h1>
        <p
          role="status"
          className="mt-2 whitespace-pre-line text-sm"
          data-testid="public-form-done"
        >
          {form.successMessage}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <h1 className="text-lg font-semibold">{form.name}</h1>
      <form className="mt-4 space-y-5" noValidate onSubmit={(event) => void submit(event)}>
        {notice === null ? null : (
          <div role="alert" className="rounded-md border border-border bg-card p-3 text-sm">
            <p>{notice.text}</p>
            {notice.reload ? (
              <Button
                type="button"
                variant="outline"
                className="mt-2"
                onClick={() => window.location.reload()}
              >
                {t('publicForm.reload')}
              </Button>
            ) : null}
          </div>
        )}

        <LeadFormFields
          idPrefix="public-form"
          fields={form.fields}
          values={values}
          errors={errors}
          onChange={set}
        />

        {/* The trap. Hidden from people and from assistive technology; a script fills it in. */}
        <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
          <label>
            Website
            <input ref={trap} type="text" name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" />
          </label>
        </div>

        <div className="space-y-1">
          <Checkbox
            id="public-form-consent"
            label={form.consentText}
            checked={consent}
            onChange={(event) => {
              setConsent(event.target.checked);
              setErrors((current) => {
                const { consent: _removed, ...rest } = current;
                return rest;
              });
            }}
          />
          {errors['consent'] === undefined ? null : (
            <p role="alert" className="text-xs text-destructive">
              {errors['consent']}
            </p>
          )}
          {form.privacyUrl === null ? null : (
            <p className="text-xs">
              <a
                href={form.privacyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                {t('publicForm.privacy')}
              </a>
            </p>
          )}
        </div>

        <Button type="submit" disabled={phase === 'sending'}>
          {phase === 'sending' ? t('publicForm.sending') : t('publicForm.submit')}
        </Button>
      </form>
    </main>
  );
}
