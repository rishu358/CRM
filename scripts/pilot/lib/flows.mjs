import { toCsv, parseCsv } from './csv.mjs';
import { unexpected, verifyEcho } from './actions.mjs';
import { sleep } from './http.mjs';

/** The API answers bad input with 422 VALIDATION_FAILED; some older routes may answer 400. Either is a refusal. */
const refused = (response) => response.status === 400 || response.status === 422;

/**
 * The less frequent things people do: bring a spreadsheet in, take one out, attach a file, delete and
 * restore, reassign work, and make the ordinary mistakes (stale edit, bad input, duplicate entry).
 */

async function putToStorage(sim, upload, bytes, label) {
  const started = performance.now();
  let response;
  try {
    response = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: bytes });
  } catch (error) {
    sim.findings.add({
      id: 'storage-upload-network',
      severity: 'high',
      kind: 'defect',
      title: 'The file store could not be reached for an upload',
      detail: String(error?.cause?.code ?? error),
    });
    return { ok: false, status: 0 };
  }
  sim.metrics.record({
    action: `storage.put (${label})`,
    ms: performance.now() - started,
    status: response.status,
    code: null,
  });
  return { ok: response.ok, status: response.status };
}

async function getFromStorage(sim, url, label) {
  const started = performance.now();
  const response = await fetch(url);
  const buffer = Buffer.from(await response.arrayBuffer());
  sim.metrics.record({
    action: `storage.get (${label})`,
    ms: performance.now() - started,
    status: response.status,
    code: null,
  });
  return { ok: response.ok, status: response.status, buffer };
}

async function waitFor(fetchJob, done, { timeoutMs = 60000, everyMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let job = await fetchJob();
  while (!done(job) && Date.now() < deadline) {
    await sleep(everyMs);
    job = await fetchJob();
  }
  return job;
}

/* ---- import --------------------------------------------------------------------------------- */

/**
 * A manager brings in a spreadsheet of contacts. It holds new people, a few people already in the system
 * (same e-mail), a few with an invalid e-mail and one with a cell that starts with "=".
 */
export async function importContacts(actor, sim) {
  const rng = sim.rng;
  const existing = actor
    .list('contact')
    .filter((contact) => contact.email)
    .slice(0, 5);
  const header = ['First name', 'Last name', 'Email', 'Phone', 'Title'];
  const rows = [header];
  const fresh = [];
  for (let index = 0; index < 30; index += 1) {
    const person = sim.builders.contact({}).payload;
    fresh.push(person);
    rows.push([person.firstName, person.lastName, person.email, person.phone, person.title ?? '']);
  }
  for (const contact of existing)
    rows.push([
      'Repeat',
      contact.lastName ?? 'Person',
      contact.email,
      sim.gen.phone(),
      'Duplicate entry',
    ]);
  rows.push(['Bad', 'Email', 'not-an-email', sim.gen.phone(), 'Typo']);
  rows.push(['Worse', 'Email', 'also@bad@example', sim.gen.phone(), 'Typo']);
  rows.push([
    'Formula',
    '=HYPERLINK("http://bad.example","click")',
    'formula.cell@example.example',
    sim.gen.phone(),
    '@SUM(1+1)',
  ]);
  const csv = toCsv(rows);
  const bytes = Buffer.from(csv);
  const expectedRows = rows.length - 1;

  const created = await actor.api.post('import.create', '/imports', {
    objectType: 'contact',
    fileName: `contacts-week${sim.week}.csv`,
    sizeBytes: bytes.length,
  });
  if (!created.ok) return unexpected(sim, actor, 'import.create', created);
  const { job, upload } = created.data;
  if (!upload) {
    sim.findings.add({
      id: 'import-no-upload-url',
      severity: 'high',
      kind: 'defect',
      title: 'Creating an import gave no upload address',
      detail: JSON.stringify(created.data).slice(0, 200),
    });
    return;
  }
  const put = await putToStorage(sim, upload, bytes, 'import');
  if (!put.ok) return;
  const uploaded = await actor.api.post('import.uploaded', `/imports/${job.id}/uploaded`);
  if (!uploaded.ok) return unexpected(sim, actor, 'import.uploaded', uploaded);

  const analysed = await waitFor(
    async () => (await actor.api.get('import.poll', `/imports/${job.id}`)).data,
    (value) => value && !['awaiting_upload', 'analyzing'].includes(value.status),
  );
  if (analysed?.status !== 'awaiting_mapping') {
    sim.findings.add({
      id: 'import-analysis-stuck',
      severity: 'high',
      kind: 'defect',
      title: `An uploaded import did not reach the mapping step (status ${analysed?.status})`,
      detail: String(analysed?.failureReason ?? ''),
    });
    return;
  }
  sim.findings.expect(analysed.totalRows === null || analysed.totalRows === expectedRows, {
    id: 'import-row-count-wrong',
    severity: 'medium',
    kind: 'defect',
    title: 'The import preview counted a different number of rows from the file',
    detail: `file has ${expectedRows}, preview says ${analysed.totalRows}`,
  });

  // Map by header: a person would match "First name" to First name and so on.
  const targets = analysed.targets ?? [];
  sim.importTargets = targets.map((target) => target.key);
  sim.importMatchFields = analysed.matchFields ?? [];
  const find = (...keys) =>
    keys.map((key) => targets.find((target) => target.key === key)).find(Boolean)?.key;
  const wanted = [
    find('first_name'),
    find('last_name'),
    find('email'),
    find('phone'),
    find('title'),
  ];
  const mapping = wanted.map((field, column) => (field ? { column, field } : null)).filter(Boolean);
  if (mapping.length < 3) {
    sim.findings.add({
      id: 'import-targets-unexpected',
      severity: 'medium',
      kind: 'friction',
      title: 'The import target field keys were not what the file headers suggest',
      detail: JSON.stringify(targets.map((target) => target.key)),
    });
    return;
  }
  const duplicateMode = rng.pick(['skip', 'update']);
  const matchField = find('email');
  const started = await actor.api.post('import.start', `/imports/${job.id}/start`, {
    mapping,
    duplicateMode,
    matchField,
  });
  if (!started.ok)
    return unexpected(
      sim,
      actor,
      'import.start',
      started,
      JSON.stringify(started.body?.error ?? ''),
    );
  const finished = await waitFor(
    async () => (await actor.api.get('import.poll', `/imports/${job.id}`)).data,
    (value) => value && ['completed', 'failed', 'rejected'].includes(value.status),
    { timeoutMs: 120000 },
  );
  actor.count('import.run');
  sim.importResult = finished;
  sim.findings.expect(finished?.status === 'completed', {
    id: 'import-did-not-complete',
    severity: 'high',
    kind: 'defect',
    title: `An import did not finish (status ${finished?.status})`,
    detail: String(finished?.failureReason ?? ''),
  });
  if (finished?.status === 'completed') {
    const total =
      finished.createdCount + finished.updatedCount + finished.skippedCount + finished.failedCount;
    sim.findings.expect(total === expectedRows, {
      id: 'import-counts-do-not-add-up',
      severity: 'high',
      kind: 'defect',
      title: 'Import counts (created+updated+skipped+failed) do not add up to the rows in the file',
      detail: `file ${expectedRows}; ${JSON.stringify({ c: finished.createdCount, u: finished.updatedCount, s: finished.skippedCount, f: finished.failedCount })}`,
    });
    sim.findings.expect(finished.createdCount >= 30 && finished.failedCount >= 2, {
      id: 'import-outcome-unexpected',
      severity: 'medium',
      kind: 'defect',
      title: 'Import outcome differs from what the file should give (30 new, 2 invalid e-mails)',
      detail: JSON.stringify({
        c: finished.createdCount,
        u: finished.updatedCount,
        s: finished.skippedCount,
        f: finished.failedCount,
        mode: duplicateMode,
      }),
    });
    if (duplicateMode === 'skip')
      sim.findings.expect(finished.skippedCount >= existing.length, {
        id: 'import-skip-duplicates-not-skipped',
        severity: 'medium',
        kind: 'defect',
        title: 'Rows matching an existing e-mail were not skipped in skip mode',
        detail: JSON.stringify({ existing: existing.length, skipped: finished.skippedCount }),
      });
    if (duplicateMode === 'update')
      sim.findings.expect(finished.updatedCount >= existing.length, {
        id: 'import-update-duplicates-not-updated',
        severity: 'medium',
        kind: 'defect',
        title: 'Rows matching an existing e-mail were not updated in update mode',
        detail: JSON.stringify({ existing: existing.length, updated: finished.updatedCount }),
      });
    if (finished.hasErrorFile) {
      const link = await actor.api.post('import.error-file', `/imports/${job.id}/error-file`);
      if (link.ok) {
        const file = await getFromStorage(sim, link.data.url, 'error file');
        const text = file.buffer.toString('utf8');
        sim.findings.expect(file.ok && text.includes('not-an-email'), {
          id: 'import-error-file-useless',
          severity: 'medium',
          kind: 'friction',
          title: 'The error file does not show the bad rows a person needs to fix',
          detail: text.slice(0, 200),
        });
        sim.errorFileSample = text.slice(0, 600);
      } else unexpected(sim, actor, 'import.error-file', link);
    } else {
      sim.findings.add({
        id: 'import-no-error-file',
        severity: 'medium',
        kind: 'defect',
        title: 'An import with invalid rows gave no downloadable error file',
        detail: JSON.stringify(finished),
      });
    }
  }
  // Refresh what the actor knows, since the import added people.
  const list = await actor.api.get('contact.list', '/contacts', {
    limit: 100,
    sort: '-created_at',
  });
  if (list.ok) for (const row of list.data) actor.track('contact', row);
  void verifyEcho;
}

/* ---- export --------------------------------------------------------------------------------- */

export async function exportRecords(actor, sim, objectType = 'lead', { filter } = {}) {
  const created = await actor.api.post('export.create', '/exports', {
    objectType,
    format: 'csv',
    filter,
    sort: '-created_at',
  });
  if (!created.ok) {
    unexpected(sim, actor, 'export.create', created, objectType);
    return null;
  }
  const job = await waitFor(
    async () => (await actor.api.get('export.poll', `/exports/${created.data.id}`)).data,
    (value) => value && ['completed', 'failed'].includes(value.status),
  );
  if (job?.status !== 'completed') {
    sim.findings.add({
      id: 'export-did-not-complete',
      severity: 'high',
      kind: 'defect',
      title: `An export did not complete (status ${job?.status})`,
      detail: String(job?.failureReason ?? ''),
    });
    return null;
  }
  const link = await actor.api.post('export.download-link', `/exports/${created.data.id}/download`);
  if (!link.ok) {
    unexpected(sim, actor, 'export.download-link', link);
    return null;
  }
  const file = await getFromStorage(sim, link.data.url, 'export');
  if (!file.ok) {
    sim.findings.add({
      id: 'export-download-failed',
      severity: 'high',
      kind: 'defect',
      title: `Downloading an export failed (HTTP ${file.status})`,
      detail: objectType,
    });
    return null;
  }
  const rows = parseCsv(file.buffer.toString('utf8'));
  actor.count('export.run');
  return {
    job,
    rows,
    header: rows[0] ?? [],
    body: rows.slice(1).filter((row) => row.some((cell) => cell !== '')),
    raw: file.buffer.toString('utf8'),
  };
}

/** Compare an export with what the same person's list shows, and look for formula injection. */
export async function exportAndCheck(actor, sim, objectType) {
  const result = await exportRecords(actor, sim, objectType);
  if (!result) return;
  const path = `/${objectType}s`;
  const all = await actor.api.listAll(`${objectType}.list-all`, path);
  if (all.ok) {
    sim.findings.expect(all.rows.length === result.body.length, {
      id: `export-row-count-differs-${objectType}`,
      severity: 'high',
      kind: 'defect',
      title: `An export of ${objectType}s has a different number of rows from the list on screen`,
      detail: `${actor.name}: list ${all.rows.length}, export ${result.body.length}`,
    });
  }
  for (const row of result.body) {
    for (const cell of row) {
      if (
        /^[=+\-@\t\r]/.test(cell) &&
        !/^[+\-]?\d[\d.,\s]*$/.test(cell) &&
        !/^\+\d{7,15}$/.test(cell)
      ) {
        sim.findings.add({
          id: 'export-formula-not-escaped',
          severity: 'high',
          kind: 'security',
          title: 'An exported cell starts with a formula character and was not escaped',
          detail: cell.slice(0, 80),
        });
      }
    }
  }
  sim.lastExportHeader = result.header;
  const phoneColumn = result.header.findIndex((name) => /phone|whatsapp/i.test(name));
  if (phoneColumn !== -1) {
    const sample = result.body
      .map((row) => row[phoneColumn])
      .filter((cell) => cell !== '' && cell !== undefined);
    const apostrophes = sample.filter((cell) => cell.startsWith("'")).length;
    if (apostrophes > 0) {
      sim.findings.add({
        id: 'export-phone-numbers-have-apostrophe',
        severity: 'medium',
        kind: 'friction',
        title:
          'Every phone number in an export starts with an apostrophe (the formula-injection guard also hits "+91..."), so the numbers are wrong when opened in a spreadsheet or re-imported',
        detail: `${actor.name}: ${apostrophes} of ${sample.length} phone cells, e.g. ${sample.find((cell) => cell.startsWith("'"))}`,
      });
    }
  }
  return result;
}

/* ---- attachments ---------------------------------------------------------------------------- */

const TINY_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

export async function attachFile(actor, sim) {
  const record = actor.pick('deal') ?? actor.pick('account');
  if (!record) return;
  const objectType = actor.book.deal.has(record.id) ? 'deal' : 'account';
  const created = await actor.api.post('attachment.create', '/attachments', {
    objectType,
    recordId: record.id,
    fileName: `quote-${sim.today}.pdf`,
    sizeBytes: TINY_PDF.length,
  });
  if (!created.ok) return unexpected(sim, actor, 'attachment.create', created);
  const put = await putToStorage(sim, created.data.upload, TINY_PDF, 'attachment');
  if (!put.ok) return;
  const confirmed = await actor.api.post(
    'attachment.uploaded',
    `/attachments/${created.data.attachment.id}/uploaded`,
  );
  if (!confirmed.ok) return unexpected(sim, actor, 'attachment.uploaded', confirmed);
  const ready = await waitFor(
    async () =>
      (await actor.api.get('attachment.poll', `/attachments/${created.data.attachment.id}`)).data,
    (value) => value && !['awaiting_upload', 'scanning'].includes(value.status),
    { timeoutMs: 30000 },
  );
  sim.findings.expect(ready?.status === 'ready', {
    id: 'attachment-not-ready',
    severity: 'high',
    kind: 'defect',
    title: `A valid PDF attachment did not become ready (status ${ready?.status})`,
    detail: String(ready?.failureReason ?? ''),
  });
  if (ready?.status === 'ready') {
    const link = await actor.api.post(
      'attachment.download-link',
      `/attachments/${ready.id}/download`,
    );
    if (link.ok) {
      const file = await getFromStorage(sim, link.data.url, 'attachment');
      sim.findings.expect(file.ok && file.buffer.equals(TINY_PDF), {
        id: 'attachment-roundtrip-differs',
        severity: 'high',
        kind: 'defect',
        title: 'A downloaded attachment is not the file that was uploaded',
        detail: `HTTP ${file.status}, ${file.buffer.length} bytes`,
      });
    } else unexpected(sim, actor, 'attachment.download-link', link);
    actor.count('attachment.stored');
  }
  const listed = await actor.api.get('attachment.list', '/attachments', {
    objectType,
    recordId: record.id,
  });
  if (listed.ok)
    sim.findings.expect(
      listed.data.some((item) => item.id === created.data.attachment.id),
      {
        id: 'attachment-not-listed',
        severity: 'high',
        kind: 'defect',
        title: 'A stored attachment is missing from the record attachment list',
        detail: record.id,
      },
    );
}

/** Files that must be refused: wrong type by name, and a ".pdf" that is really something else. */
export async function attachBadFiles(actor, sim) {
  const record = actor.pick('account');
  if (!record) return;
  const exe = await actor.api.post('attachment.create-exe', '/attachments', {
    objectType: 'account',
    recordId: record.id,
    fileName: 'invoice.exe',
    sizeBytes: 1000,
  });
  sim.findings.expect(refused(exe), {
    id: 'attachment-exe-accepted',
    severity: 'high',
    kind: 'security',
    title: 'An .exe attachment was not refused',
    detail: `HTTP ${exe.status}`,
  });
  const fake = Buffer.from('MZ this is not a pdf at all, it is a program header');
  const created = await actor.api.post('attachment.create-fake', '/attachments', {
    objectType: 'account',
    recordId: record.id,
    fileName: 'statement.pdf',
    sizeBytes: fake.length,
  });
  if (!created.ok) return unexpected(sim, actor, 'attachment.create-fake', created);
  await putToStorage(sim, created.data.upload, fake, 'attachment');
  await actor.api.post(
    'attachment.uploaded',
    `/attachments/${created.data.attachment.id}/uploaded`,
  );
  const settled = await waitFor(
    async () =>
      (await actor.api.get('attachment.poll', `/attachments/${created.data.attachment.id}`)).data,
    (value) => value && !['awaiting_upload', 'scanning'].includes(value.status),
    { timeoutMs: 30000 },
  );
  sim.findings.expect(settled?.status === 'rejected', {
    id: 'attachment-fake-pdf-accepted',
    severity: 'high',
    kind: 'security',
    title: 'A file named .pdf whose content is not a PDF was accepted',
    detail: `status ${settled?.status}`,
  });
}

/* ---- recycle bin ---------------------------------------------------------------------------- */

export async function deleteAndRestore(actor, sim) {
  const type = sim.rng.pick(['contact', 'deal', 'account', 'lead']);
  const record = actor.pick(type);
  if (!record) return;
  const path = `/${type}s/${record.id}`;
  const deleted = await actor.api.delete(`${type}.delete`, path, { version: record.version });
  if (!deleted.ok) {
    if (deleted.status === 403 && (actor.role === 'Sales Rep' || actor.role.startsWith('Junior'))) {
      // Sales reps have no delete grant: a documented rule, and a normal answer.
      sim.findings.add({
        id: 'rep-cannot-delete-own-records',
        severity: 'info',
        kind: 'observation',
        title:
          'A Sales Rep cannot delete a record they created (no delete grant in the default role)',
        detail: `${type}`,
      });
      return;
    }
    return unexpected(sim, actor, `${type}.delete`, deleted);
  }
  actor.count('record.deleted');
  actor.forget(type, record.id);
  const gone = await actor.api.get(`${type}.get-deleted`, path);
  sim.findings.expect(gone.status === 404, {
    id: 'deleted-record-still-readable',
    severity: 'high',
    kind: 'defect',
    title: 'A deleted record can still be opened',
    detail: `${type}: HTTP ${gone.status}`,
  });
  const bin = await actor.api.get('recycle-bin.list', '/recycle-bin', { objectType: type });
  if (!bin.ok) return unexpected(sim, actor, 'recycle-bin.list', bin);
  const entry = bin.data.find((item) => item.id === record.id);
  if (!entry) {
    sim.findings.add({
      id: 'deleted-record-not-in-bin',
      severity: 'high',
      kind: 'defect',
      title: 'A deleted record is not in the Recycle Bin',
      detail: `${type} ${record.id}`,
    });
    return;
  }
  sim.findings.expect(new Date(entry.purgeAfter) - new Date(entry.deletedAt) >= 29 * 86400000, {
    id: 'recycle-bin-retention-short',
    severity: 'medium',
    kind: 'defect',
    title: 'Recycle Bin keeps a record for less than the 30 days the spec promises',
    detail: `${entry.deletedAt} -> ${entry.purgeAfter}`,
  });
  let restored = await actor.api.post(
    'recycle-bin.restore',
    `/recycle-bin/${type}/${record.id}/restore`,
    { version: entry.version },
  );
  if (
    !restored.ok &&
    restored.status === 404 &&
    record.ownerId &&
    record.ownerId !== actor.userId
  ) {
    sim.findings.add({
      id: 'manager-cannot-restore-team-record',
      severity: 'high',
      kind: 'defect',
      title:
        "A Manager can delete a team member's record and see it in the Recycle Bin, but Restore answers 404 and the record stays deleted",
      detail: `${type} ${record.id}: ${restored.body?.error?.message}. Restoring it as the owner worked.`,
    });
    // The owner puts it back, so the rest of the simulation is not short of records.
    restored = await sim.ownerApi.post(
      'recycle-bin.restore-by-owner',
      `/recycle-bin/${type}/${record.id}/restore`,
      { version: entry.version },
    );
  }
  if (!restored.ok) return unexpected(sim, actor, 'recycle-bin.restore', restored);
  actor.count('record.restored');
  const back = await actor.api.get(`${type}.get-restored`, path);
  sim.findings.expect(back.ok, {
    id: 'restored-record-unreadable',
    severity: 'high',
    kind: 'defect',
    title: 'A restored record cannot be opened',
    detail: `${type}: HTTP ${back.status}`,
  });
  if (back.ok) actor.track(type, back.data);
}

/* ---- the ordinary mistakes ------------------------------------------------------------------- */

export async function makeMistakes(actor, sim) {
  const rng = sim.rng;
  const kind = rng.pick([
    'stale',
    'stale',
    'invalid-email',
    'invalid-phone',
    'unknown-field',
    'duplicate-contact',
    'lost-without-reason',
    'empty-name',
    'bad-id',
    'huge-note',
  ]);
  const mistakes = (sim.mistakes ??= {});
  const note = (name, ok) => {
    mistakes[name] = mistakes[name] ?? { tried: 0, behaved: 0 };
    mistakes[name].tried += 1;
    if (ok) mistakes[name].behaved += 1;
  };

  if (kind === 'stale') {
    const record = actor.pick('deal') ?? actor.pick('account');
    if (!record) return;
    const type = actor.book.deal.has(record.id) ? 'deal' : 'account';
    // Two people open the record; the first saves; the second saves with the old version.
    const first = await actor.api.patch(`${type}.update`, `/${type}s/${record.id}`, {
      version: record.version,
      ...(type === 'deal'
        ? { expectedCloseDate: addDaysSafe(sim.today, 12) }
        : { phone: sim.gen.phone() }),
    });
    if (!first.ok) return unexpected(sim, actor, `${type}.update`, first);
    actor.track(type, first.data);
    const second = await actor.api.patch(`${type}.update-stale`, `/${type}s/${record.id}`, {
      version: record.version,
      ...(type === 'deal'
        ? { expectedCloseDate: addDaysSafe(sim.today, 30) }
        : { phone: sim.gen.phone() }),
    });
    note('stale edit', second.status === 409);
    sim.findings.expect(second.status === 409 && second.code, {
      id: 'stale-edit-not-409',
      severity: 'high',
      kind: 'defect',
      title: 'A stale-version edit was not refused with 409',
      detail: `HTTP ${second.status} ${second.code}`,
    });
    if (second.status === 409)
      sim.staleExample = {
        code: second.code,
        message: second.body?.error?.message,
        details: second.body?.error?.details,
      };
    // Only people who may delete can be told their version is stale; a rep is refused earlier, with 403.
    const delStale = await actor.api.delete(`${type}.delete-stale`, `/${type}s/${record.id}`, {
      version: record.version,
    });
    sim.findings.expect(
      delStale.status === 409 ||
        (delStale.status === 403 &&
          (actor.role === 'Sales Rep' || actor.role.startsWith('Junior'))),
      {
        id: 'stale-delete-not-409',
        severity: 'high',
        kind: 'defect',
        title: 'Deleting with a stale version was not refused with 409',
        detail: `HTTP ${delStale.status}`,
      },
    );
  } else if (kind === 'invalid-email') {
    const built = sim.builders.contact({}).payload;
    built.email = rng.pick([
      'rahul@@gmail',
      'no-at-sign.example',
      'a b@c.example',
      'trailing@dot.',
    ]);
    const response = await actor.api.post('contact.create-invalid', '/contacts', built);
    note('invalid e-mail', refused(response) && response.code === 'VALIDATION_FAILED');
    sim.findings.expect(refused(response), {
      id: 'invalid-email-accepted',
      severity: 'medium',
      kind: 'defect',
      title: 'A contact with an invalid e-mail address was accepted',
      detail: `${built.email}: HTTP ${response.status}`,
    });
    if (refused(response)) sim.invalidExample = response.body?.error;
  } else if (kind === 'invalid-phone') {
    const built = sim.builders.contact({}).payload;
    built.phone = rng.pick(['98765 43210', '09876543210', '+91-98765-43210', '12345']);
    const response = await actor.api.post('contact.create-badphone', '/contacts', built);
    note('phone not in E.164', refused(response));
    sim.findings.expect(refused(response), {
      id: 'bad-phone-accepted',
      severity: 'medium',
      kind: 'defect',
      title: 'A phone number not in international format was accepted',
      detail: `${built.phone}: HTTP ${response.status}`,
    });
    if (refused(response)) {
      sim.findings.add({
        id: 'phone-must-be-e164-strict',
        severity: 'low',
        kind: 'friction',
        title:
          'Phone numbers must be typed in +91... form; "98765 43210" and "09876543210" are refused with a generic message',
        detail: JSON.stringify(response.body?.error?.details ?? []).slice(0, 200),
      });
    }
  } else if (kind === 'unknown-field') {
    const built = sim.builders.contact({}).payload;
    built.nickname = 'Bunty';
    const response = await actor.api.post('contact.create-unknown', '/contacts', built);
    note('unknown field', refused(response));
    sim.findings.expect(refused(response), {
      id: 'unknown-key-accepted',
      severity: 'medium',
      kind: 'defect',
      title: 'A request with an unknown field was accepted',
      detail: `HTTP ${response.status}`,
    });
  } else if (kind === 'duplicate-contact') {
    const existing = actor.pick('contact', (item) => item.email);
    if (!existing) return;
    const built = sim.builders.contact({ accountId: existing.accountId ?? null }).payload;
    built.email = existing.email.toUpperCase();
    const before = await actor.api.post('lead.duplicate-check', '/leads/duplicate-check', {
      email: built.email,
    });
    const response = await actor.api.post('contact.create-duplicate', '/contacts', built);
    note('duplicate contact', response.status === 409 || refused(response));
    sim.duplicateContact = {
      status: response.status,
      code: response.code,
      checkEndpointMatches: before.ok ? before.data.length : null,
    };
    sim.findings.expect(response.status === 409 || refused(response), {
      id: 'duplicate-contact-silently-created',
      severity: 'medium',
      kind: 'defect',
      title:
        'A second contact with the same e-mail address (different capitals) is created without any warning',
      detail: `POST /contacts returned ${response.status}; the separate duplicate-check endpoint found ${before.ok ? before.data.length : '?'} match(es) but only exists for leads`,
    });
    if (response.ok) {
      actor.track('contact', response.data);
      actor.count('duplicate.contact.created');
    }
  } else if (kind === 'lost-without-reason') {
    const candidate = actor.pick('deal', (deal) => !deal.closedAt);
    if (!candidate) return;
    // Fetch the current version first: this probe is about the missing reason, not about a stale edit.
    const fresh = await actor.api.get('deal.get', `/deals/${candidate.id}`);
    if (!fresh.ok || fresh.data.closedAt) return;
    const open = fresh.data;
    const response = await actor.api.patch('deal.lost-no-reason', `/deals/${open.id}`, {
      version: open.version,
      stageId: sim.context.lostStage.id,
    });
    note('lost without reason', refused(response));
    sim.findings.expect(refused(response), {
      id: 'lost-without-reason-accepted',
      severity: 'medium',
      kind: 'defect',
      title: 'A deal was marked Lost with no reason (the spec says the reason is mandatory)',
      detail: `HTTP ${response.status}`,
    });
    if (response.ok) actor.track('deal', response.data);
  } else if (kind === 'empty-name') {
    const response = await actor.api.post('account.create-empty', '/accounts', { name: '   ' });
    note('empty account name', refused(response));
    sim.findings.expect(refused(response), {
      id: 'empty-name-accepted',
      severity: 'medium',
      kind: 'defect',
      title: 'An account with a blank name was accepted',
      detail: `HTTP ${response.status}`,
    });
  } else if (kind === 'bad-id') {
    const response = await actor.api.get('account.get-badid', '/accounts/not-a-uuid');
    note('malformed id', refused(response) || response.status === 404);
    sim.findings.expect(refused(response) || response.status === 404, {
      id: 'bad-id-server-error',
      severity: 'medium',
      kind: 'defect',
      title: 'A malformed record id gives something other than 400/404',
      detail: `HTTP ${response.status}`,
    });
  } else if (kind === 'huge-note') {
    const record = actor.pick('account');
    if (!record) return;
    const response = await actor.api.post('note.create-huge', '/activities', {
      type: 'note',
      subject: 'Pasted email thread',
      body: 'x'.repeat(40000),
      links: [{ objectType: 'account', recordId: record.id }],
    });
    note('note over the size limit', refused(response));
    sim.findings.expect(refused(response), {
      id: 'huge-note-accepted',
      severity: 'low',
      kind: 'defect',
      title: 'A note over the 32,000 character limit was accepted',
      detail: `HTTP ${response.status}`,
    });
  }
}

function addDaysSafe(date, days) {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

/* ---- the manager's team work -------------------------------------------------------------------- */

export async function reassignWork(actor, sim, toActor) {
  const mine = actor
    .list('deal')
    .filter((deal) => !deal.closedAt && deal.ownerId !== toActor.userId)
    .slice(0, 5);
  if (mine.length === 0) return;
  const body = {
    mode: 'records',
    objectType: 'deal',
    recordIds: mine.map((deal) => deal.id),
    toOwnerId: toActor.userId,
  };
  // The Manager role is described as one that "can reassign work". Try it as the manager would.
  let worker = actor;
  const preview = await actor.api.post('ownership.preview', '/ownership/preview', body);
  if (!preview.ok && preview.status === 422) {
    sim.findings.add({
      id: 'manager-cannot-reassign',
      severity: 'high',
      kind: 'defect',
      title:
        'A Manager cannot reassign work: the default Manager role has team scope, and reassigning needs all scope, so the answer is 422 "You cannot assign records to another user" (the role description and MVP_SPEC both say a Manager reassigns work)',
      detail: JSON.stringify(preview.body?.error?.details ?? []),
    });
    // The owner does it instead, so the rest of the simulation can see a reassignment arrive.
    worker = { api: sim.ownerApi, name: 'owner', count() {} };
    const again = await worker.api.post('ownership.preview', '/ownership/preview', body);
    if (!again.ok) return unexpected(sim, actor, 'ownership.preview', again, 'as owner');
  } else if (!preview.ok) {
    return unexpected(sim, actor, 'ownership.preview', preview);
  }
  const before = await toActor.api.get('notifications.unread', '/notifications/unread-count');
  const response = await worker.api.post('ownership.reassign', '/ownership/reassign', body);
  if (!response.ok) return unexpected(sim, actor, 'ownership.reassign', response);
  actor.count('reassign');
  // The receiving rep must now be able to see them, and should hear about it.
  const seen = await toActor.api.get('deal.get-reassigned', `/deals/${mine[0].id}`);
  sim.findings.expect(seen.ok && seen.data.ownerId === toActor.userId, {
    id: 'reassigned-deal-not-visible-to-new-owner',
    severity: 'high',
    kind: 'defect',
    title: 'A deal reassigned to a rep cannot be opened by that rep',
    detail: `HTTP ${seen.status}`,
  });
  if (seen.ok) toActor.track('deal', seen.data);
  for (const deal of mine) actor.forget('deal', deal.id);
  await sleep(1500);
  const after = await toActor.api.get('notifications.unread', '/notifications/unread-count');
  sim.reassignNotice = { before: before.data, after: after.data };
  if (before.data?.unread !== undefined && after.data?.unread === before.data.unread) {
    sim.findings.add({
      id: 'reassign-sends-no-notification',
      severity: 'low',
      kind: 'gap',
      title:
        'A rep is not told when deals are reassigned to them: notifications exist only for assigned and due tasks',
      detail: `unread ${before.data.unread} -> ${after.data.unread}`,
    });
  }
}

/** A manager hands a task to a rep, as a manager does every day. The rep should be told. */
export async function assignTask(actor, sim, toActor) {
  const before = await toActor.api.get('notifications.unread', '/notifications/unread-count');
  const deal = actor.pick('deal', (item) => !item.closedAt);
  const body = {
    type: 'task',
    subject: `Please follow up this deal this week`,
    dueAt: `${addDaysSafe(sim.today, 2)}T09:30:00.000Z`,
    assignedTo: toActor.userId,
    priority: 'high',
  };
  if (deal) body.links = [{ objectType: 'deal', recordId: deal.id }];
  const response = await actor.api.post('activity.assign', '/activities', body);
  if (!response.ok) {
    sim.findings.add({
      id: 'manager-cannot-assign-task',
      severity: 'high',
      kind: 'defect',
      title: 'A Manager cannot assign a task to a member of their team',
      detail: `HTTP ${response.status} ${JSON.stringify(response.body?.error?.details ?? response.body?.error?.message)}`,
    });
    return;
  }
  actor.count('task.assigned');
  await sleep(2000);
  const after = await toActor.api.get('notifications.unread', '/notifications/unread-count');
  const list = await toActor.api.get('notifications.list', '/notifications', {
    limit: 10,
    unreadOnly: true,
  });
  const found =
    list.ok &&
    list.data.some(
      (item) =>
        item.type === 'activity.assigned' &&
        JSON.stringify(item.payload).includes(response.data.id),
    );
  sim.findings.expect(found, {
    id: 'assigned-task-no-notification',
    severity: 'medium',
    kind: 'defect',
    title: 'A rep was not notified (within 2 s) of a task assigned to them by their manager',
    detail: `unread ${before.data?.unread} -> ${after.data?.unread}`,
  });
  const mine = await toActor.api.get('activity.get-assigned', `/activities/${response.data.id}`);
  sim.findings.expect(mine.ok, {
    id: 'assigned-task-not-visible-to-assignee',
    severity: 'high',
    kind: 'defect',
    title: 'A task assigned to a rep cannot be opened by that rep',
    detail: `HTTP ${mine.status}`,
  });
}

export async function conflictBetweenPeople(actorA, actorB, sim) {
  // The manager and a rep both have the same deal open and both save: the second must be told.
  const deal = actorB.pick('deal', (item) => !item.closedAt);
  if (!deal) return;
  const fresh = await actorA.api.get('deal.get', `/deals/${deal.id}`);
  if (!fresh.ok) return;
  const a = await actorA.api.patch('deal.update', `/deals/${deal.id}`, {
    version: fresh.data.version,
    expectedCloseDate: addDaysSafe(sim.today, 9),
  });
  const b = await actorB.api.patch('deal.update-stale', `/deals/${deal.id}`, {
    version: fresh.data.version,
    expectedCloseDate: addDaysSafe(sim.today, 16),
  });
  sim.findings.expect(a.ok && b.status === 409, {
    id: 'two-person-edit-conflict-missed',
    severity: 'high',
    kind: 'defect',
    title: 'Two people saving the same deal from the same version: the second was not refused',
    detail: `first HTTP ${a.status}, second HTTP ${b.status}`,
  });
  if (a.ok) actorB.track('deal', a.data);
}

export { putToStorage, getFromStorage, waitFor };
