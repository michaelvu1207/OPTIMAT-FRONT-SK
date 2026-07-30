/**
 * Audio transcription Lambda Function.
 *
 * Routes:
 *   POST /transcribe -> multipart/form-data { file }
 */

import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHandler, errorResponse, jsonResponse } from '../_shared/adapter.js';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
  DeleteTranscriptionJobCommand,
  type MediaFormat,
} from '@aws-sdk/client-transcribe';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const region = process.env.AWS_REGION || 'us-west-1';
const s3 = new S3Client({ region });
const transcribe = new TranscribeClient({ region });

interface MultipartFile {
  filename: string;
  contentType: string;
  content: Buffer;
}

function extractBoundary(contentType: string): string | null {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  return match?.[1] || match?.[2] || null;
}

function parseContentDisposition(value: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const part of value.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (!rawKey || rawValue.length === 0) continue;
    params[rawKey.toLowerCase()] = rawValue.join('=').replace(/^"|"$/g, '');
  }
  return params;
}

function trimTrailingLineBreak(content: string): string {
  if (content.endsWith('\r\n')) return content.slice(0, -2);
  if (content.endsWith('\n')) return content.slice(0, -1);
  return content;
}

function parseMultipartFile(event: APIGatewayProxyEventV2): MultipartFile | null {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.headers || {})) {
    headers[key.toLowerCase()] = value || '';
  }

  const contentType = headers['content-type'] || '';
  const boundary = extractBoundary(contentType);
  if (!boundary || !event.body) return null;

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body, 'utf8');
  const body = rawBody.toString('latin1');
  const boundaryMarker = `--${boundary}`;
  const parts = body.split(boundaryMarker);

  for (const rawPart of parts) {
    if (!rawPart || rawPart === '--' || rawPart === '--\r\n') continue;

    const part = rawPart.startsWith('\r\n') ? rawPart.slice(2) : rawPart;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headerText = part.slice(0, headerEnd);
    const contentText = trimTrailingLineBreak(part.slice(headerEnd + 4));
    const partHeaders: Record<string, string> = {};

    for (const line of headerText.split('\r\n')) {
      const separator = line.indexOf(':');
      if (separator === -1) continue;
      const key = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      partHeaders[key] = value;
    }

    const disposition = partHeaders['content-disposition'];
    if (!disposition) continue;

    const dispositionParams = parseContentDisposition(disposition);
    if (dispositionParams.name !== 'file') continue;

    return {
      filename: dispositionParams.filename || 'voice-input.webm',
      contentType: partHeaders['content-type'] || 'application/octet-stream',
      content: Buffer.from(contentText, 'latin1'),
    };
  }

  return null;
}

function getFileExtension(file: MultipartFile): string {
  if (file.filename.includes('.')) {
    return file.filename.split('.').pop() || 'webm';
  }
  if (file.contentType.includes('mp4')) return 'mp4';
  if (file.contentType.includes('ogg')) return 'ogg';
  if (file.contentType.includes('mpeg')) return 'mp3';
  return 'webm';
}

export const handler = createHandler(async (req) => {
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, req.origin);
  }

  const file = parseMultipartFile(req.rawEvent);
  if (!file) {
    return errorResponse('Missing audio file.', 400, req.origin);
  }

  if (file.content.byteLength <= 0) {
    return errorResponse('Audio file was empty.', 400, req.origin);
  }

  if (file.content.byteLength > MAX_AUDIO_BYTES) {
    return errorResponse('Audio file is too large. Please record a shorter message.', 413, req.origin);
  }

  const extension = getFileExtension(file);
  const allowedFormats = new Set(['mp3', 'mp4', 'wav', 'flac', 'ogg', 'amr', 'webm', 'm4a']);
  const mediaFormat = (allowedFormats.has(extension.toLowerCase()) ? extension.toLowerCase() : 'webm') as MediaFormat;
  const bucket = process.env.TRANSCRIBE_BUCKET;
  if (!bucket) return errorResponse('Amazon Transcribe storage is not configured.', 500, req.origin);

  const jobName = `optimat-${randomUUID()}`;
  const objectKey = `transcribe-input/${jobName}.${mediaFormat}`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    Body: file.content,
    ContentType: file.contentType,
    ServerSideEncryption: 'AES256',
  }));

  await transcribe.send(new StartTranscriptionJobCommand({
    TranscriptionJobName: jobName,
    LanguageCode: 'en-US',
    MediaFormat: mediaFormat,
    Media: { MediaFileUri: `s3://${bucket}/${objectKey}` },
  }));

  const deadline = Date.now() + 24_000;
  while (Date.now() < deadline) {
    const result = await transcribe.send(new GetTranscriptionJobCommand({
      TranscriptionJobName: jobName,
    }));
    const status = result.TranscriptionJob?.TranscriptionJobStatus;
    if (status === 'COMPLETED') {
      const uri = result.TranscriptionJob?.Transcript?.TranscriptFileUri;
      const transcriptResponse = uri ? await fetch(uri) : null;
      const transcript = transcriptResponse?.ok
        ? await transcriptResponse.json() as { results?: { transcripts?: Array<{ transcript?: string }> } }
        : null;
      await Promise.allSettled([
        s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey })),
        transcribe.send(new DeleteTranscriptionJobCommand({ TranscriptionJobName: jobName })),
      ]);
      return jsonResponse({
        text: transcript?.results?.transcripts?.[0]?.transcript || '',
        model: 'amazon-transcribe',
      }, 200, req.origin);
    }
    if (status === 'FAILED') {
      await Promise.allSettled([
        s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey })),
        transcribe.send(new DeleteTranscriptionJobCommand({ TranscriptionJobName: jobName })),
      ]);
      return errorResponse('Amazon Transcribe could not process this audio.', 422, req.origin);
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }

  return errorResponse('Transcription timed out. Please try a shorter recording.', 504, req.origin);
});
