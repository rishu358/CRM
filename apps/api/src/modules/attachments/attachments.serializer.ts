import type { Attachment as AttachmentContract } from '@crm/contracts';
import type { Attachment } from '@crm/db';

/**
 * An attachment as the API returns it.
 *
 * **`fileKey` is absent, and that is the whole job of this function.** The key
 * is the capability to read the file: anything holding one holds a way to ask
 * the object store for the bytes without going through the audited,
 * permission-checked link endpoint. It is random precisely so that it cannot
 * be guessed, which is worth nothing if it is printed in a list response.
 *
 * Nothing here is field-permission filtered, because an attachment has no
 * fields in `field_definitions`: it is not a metadata-driven record (ADR-0004)
 * and has no custom fields. What a caller may see about a file follows
 * entirely from whether they may read the record it hangs from.
 */
export function serializeAttachment(attachment: Attachment): AttachmentContract {
  return {
    id: attachment.id,
    objectType: attachment.objectType,
    recordId: attachment.recordId,
    fileName: attachment.fileName,
    mime: attachment.mime,
    sizeBytes: attachment.sizeBytes,
    status: attachment.status,
    failureReason: attachment.failureReason ?? null,
    createdAt: attachment.createdAt.toISOString(),
    createdBy: attachment.createdBy ?? null,
  };
}
