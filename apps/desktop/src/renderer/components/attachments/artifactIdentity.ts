import {
  IconFile,
  IconFileText,
  IconMail,
  IconPhoto,
  IconPresentation,
  IconTable,
  IconVideo,
  IconFileTypePdf,
  IconFileZip,
} from '@tabler/icons-react';
import { t } from '../../i18n/i18n';

/** Same identity in chat attachments and Work. Unknown formats remain downloadable files. */
export function artifactIdentity(file: { filename: string; mimeType: string }) {
  const mime = file.mimeType;
  const ext = file.filename.split('.').at(-1)?.toLowerCase();
  if (mime.startsWith('image/')) return { label: t('attachments.kind.image'), Icon: IconPhoto };
  if (mime.startsWith('video/')) return { label: t('attachments.kind.video'), Icon: IconVideo };
  if (mime === 'application/pdf')
    return { label: t('attachments.kind.pdf'), Icon: IconFileTypePdf };
  if (
    mime === 'text/csv' ||
    mime.includes('spreadsheet') ||
    mime.includes('excel') ||
    ['xlsx', 'xls', 'csv', 'ods'].includes(ext ?? '')
  )
    return { label: t('attachments.kind.spreadsheet'), Icon: IconTable };
  if (
    mime.includes('presentation') ||
    mime.includes('powerpoint') ||
    ['pptx', 'ppt', 'odp'].includes(ext ?? '')
  )
    return { label: t('attachments.kind.presentation'), Icon: IconPresentation };
  if (mime === 'message/rfc822' || ext === 'eml')
    return { label: t('attachments.kind.email'), Icon: IconMail };
  if (mime.includes('wordprocessing') || ['doc', 'docx', 'odt'].includes(ext ?? ''))
    return { label: t('attachments.kind.document'), Icon: IconFileText };
  if (mime === 'text/markdown' || ext === 'md')
    return { label: t('attachments.kind.markdown'), Icon: IconFileText };
  if (mime === 'application/zip')
    return { label: t('attachments.kind.archive'), Icon: IconFileZip };
  if (mime === 'application/json') return { label: t('attachments.kind.json'), Icon: IconFileText };
  if (mime.startsWith('text/')) return { label: t('attachments.kind.text'), Icon: IconFileText };
  return { label: t('attachments.kind.file'), Icon: IconFile };
}
