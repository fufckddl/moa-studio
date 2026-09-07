import type { PhotoChatMessage } from '../types';
import { getSupabaseClient, isCloudConfigured } from './supabase';

const LOCAL_PREFIX = 'moa-studio:photo-chat-history:v1';
const GUEST_USER_ID = 'guest';
const MAX_MESSAGES = 200;
const USER_MAX_CHARS = 2000;
const ASSISTANT_MAX_CHARS = 4000;

interface LocalRecord {
  messages: PhotoChatMessage[];
  updatedAt: string;
  dirty: boolean;
  revision: string;
}

interface CloudRecord {
  messages: unknown;
  updated_at: string | null;
}

interface QueueState {
  promise: Promise<void>;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class PhotoChatHistoryError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'PhotoChatHistoryError';
    this.status = options.status;
    this.retryable = options.retryable ?? true;
  }
}

const memoryStorage = new Map<string, string>();
const writeQueues = new Map<string, QueueState>();
let localRevisionCounter = 0;

function getStorage(): StorageLike {
  const browserStorage = globalThis.window?.localStorage;
  if (browserStorage) return browserStorage;

  return {
    getItem: (key) => memoryStorage.get(key) ?? null,
    setItem: (key, value) => {
      memoryStorage.set(key, value);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeUserId(userId: string | null): string {
  const value = userId?.trim();
  return value || GUEST_USER_ID;
}

function normalizeConversationId(conversationId: string): string {
  const value = conversationId.trim();
  if (!value || value.length > 120) {
    throw new PhotoChatHistoryError('사진 대화 저장 위치가 올바르지 않아요.', { status: 400, retryable: false });
  }
  return value;
}

function localKey(userId: string | null, conversationId: string): string {
  return `${LOCAL_PREFIX}:${encodeURIComponent(normalizeUserId(userId))}:${encodeURIComponent(normalizeConversationId(conversationId))}`;
}

function queueKey(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

function nextRevision(): string {
  localRevisionCounter = (localRevisionCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now()}:${localRevisionCounter}`;
}

function validateMessages(messages: PhotoChatMessage[]): PhotoChatMessage[] {
  if (!Array.isArray(messages) || messages.length > MAX_MESSAGES) {
    throw new PhotoChatHistoryError('사진 대화는 최대 200개까지 저장할 수 있어요.', { status: 400, retryable: false });
  }

  return messages.map((message) => {
    if (!isRecord(message)) {
      throw new PhotoChatHistoryError('사진 대화 형식이 올바르지 않아요.', { status: 400, retryable: false });
    }

    const keys = Object.keys(message);
    const role = message.role;
    const content = message.content;
    const maxLength = role === 'assistant' ? ASSISTANT_MAX_CHARS : USER_MAX_CHARS;
    if (
      keys.length !== 2 ||
      !keys.includes('role') ||
      !keys.includes('content') ||
      (role !== 'user' && role !== 'assistant') ||
      typeof content !== 'string' ||
      content.length > maxLength
    ) {
      throw new PhotoChatHistoryError('사진 대화 형식이 올바르지 않아요.', { status: 400, retryable: false });
    }

    return { role, content };
  });
}

function parseStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const status = error.status;
  return typeof status === 'number' ? status : undefined;
}

function historyError(error: unknown): PhotoChatHistoryError {
  if (error instanceof PhotoChatHistoryError) return error;
  const status = parseStatus(error);
  if (error instanceof Error) {
    return new PhotoChatHistoryError(error.message, { status });
  }
  if (isRecord(error) && typeof error.message === 'string') {
    return new PhotoChatHistoryError(error.message, { status });
  }
  return new PhotoChatHistoryError('사진 대화를 동기화하지 못했어요. 잠시 후 다시 시도해 주세요.', { status });
}

function readLocalRecord(userId: string | null, conversationId: string): LocalRecord | null {
  const raw = getStorage().getItem(localKey(userId, conversationId));
  if (!raw) return null;

  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !Array.isArray(value.messages) || typeof value.updatedAt !== 'string') return null;
    return {
      messages: validateMessages(value.messages as PhotoChatMessage[]),
      updatedAt: value.updatedAt,
      dirty: value.dirty === true,
      revision: typeof value.revision === 'string' ? value.revision : value.updatedAt,
    };
  } catch {
    return null;
  }
}

function writeLocalRecord(userId: string | null, conversationId: string, record: LocalRecord): void {
  getStorage().setItem(localKey(userId, conversationId), JSON.stringify({
    messages: validateMessages(record.messages),
    updatedAt: record.updatedAt,
    dirty: record.dirty,
    revision: record.revision,
  }));
}

function shouldUseCloud(userId: string | null): userId is string {
  return isCloudConfigured && Boolean(userId?.trim()) && userId !== GUEST_USER_ID;
}

async function verifyCloudUser(userId: string): Promise<void> {
  const { data, error } = await getSupabaseClient().auth.getUser();
  if (error) throw historyError(error);
  if (data.user?.id !== userId) {
    throw new PhotoChatHistoryError('로그인 세션을 다시 확인해 주세요.', { status: 401, retryable: false });
  }
}

async function loadCloudRecord(userId: string, conversationId: string): Promise<LocalRecord | null> {
  await verifyCloudUser(userId);
  const { data, error } = await getSupabaseClient()
    .from('photo_chat_history')
    .select('messages, updated_at')
    .eq('user_id', userId)
    .eq('conversation_id', conversationId)
    .maybeSingle<CloudRecord>();

  if (error) throw historyError(error);
  if (!data) return null;

  return {
    messages: validateMessages(data.messages as PhotoChatMessage[]),
    updatedAt: data.updated_at ?? new Date(0).toISOString(),
    dirty: false,
    revision: data.updated_at ?? new Date(0).toISOString(),
  };
}

async function upsertCloudRecord(userId: string, conversationId: string, record: LocalRecord): Promise<void> {
  await verifyCloudUser(userId);
  const { error } = await getSupabaseClient()
    .from('photo_chat_history')
    .upsert({
      user_id: userId,
      conversation_id: conversationId,
      messages: record.messages,
      updated_at: record.updatedAt,
    }, { onConflict: 'user_id,conversation_id' });

  if (error) throw historyError(error);
}

async function flushLocalRecord(userId: string, conversationId: string, record: LocalRecord): Promise<void> {
  await upsertCloudRecord(userId, conversationId, record);
  const current = readLocalRecord(userId, conversationId);
  if (current?.revision === record.revision) {
    writeLocalRecord(userId, conversationId, { ...record, dirty: false });
  }
}

function enqueueCloudWrite(userId: string, conversationId: string, record: LocalRecord): Promise<void> {
  const key = queueKey(userId, conversationId);
  const previous = writeQueues.get(key)?.promise ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const current = readLocalRecord(userId, conversationId);
    if (current?.revision !== record.revision) return;
    await flushLocalRecord(userId, conversationId, record);
  });
  writeQueues.set(key, { promise: next });
  void next.then(() => {
    if (writeQueues.get(key)?.promise === next) writeQueues.delete(key);
  }, () => {
    if (writeQueues.get(key)?.promise === next) writeQueues.delete(key);
  });
  return next;
}

export async function loadChatHistory(userId: string | null, conversationId: string): Promise<PhotoChatMessage[]> {
  const normalizedConversationId = normalizeConversationId(conversationId);
  const local = readLocalRecord(userId, normalizedConversationId);

  if (!shouldUseCloud(userId)) return local?.messages ?? [];

  if (local?.dirty) {
    await enqueueCloudWrite(userId, normalizedConversationId, local);
  }

  const cloud = await loadCloudRecord(userId, normalizedConversationId);
  const latestLocal = readLocalRecord(userId, normalizedConversationId);
  if (!cloud) return latestLocal?.messages ?? local?.messages ?? [];

  if (
    latestLocal &&
    (latestLocal.dirty || Date.parse(latestLocal.updatedAt) > Date.parse(cloud.updatedAt))
  ) {
    const pending = { ...latestLocal, dirty: true };
    writeLocalRecord(userId, normalizedConversationId, pending);
    await enqueueCloudWrite(userId, normalizedConversationId, pending);
    return latestLocal.messages;
  }

  writeLocalRecord(userId, normalizedConversationId, cloud);
  return cloud.messages;
}

export function readCachedChatHistory(userId: string | null, conversationId: string): PhotoChatMessage[] | null {
  return readLocalRecord(userId, conversationId)?.messages ?? null;
}

export async function saveChatHistory(userId: string | null, conversationId: string, messages: PhotoChatMessage[]): Promise<void> {
  const normalizedConversationId = normalizeConversationId(conversationId);
  const record: LocalRecord = {
    messages: validateMessages(messages),
    updatedAt: new Date().toISOString(),
    dirty: shouldUseCloud(userId),
    revision: nextRevision(),
  };
  writeLocalRecord(userId, normalizedConversationId, record);

  if (!shouldUseCloud(userId)) return;

  try {
    await enqueueCloudWrite(userId, normalizedConversationId, record);
  } catch (error) {
    const current = readLocalRecord(userId, normalizedConversationId);
    if (current?.revision === record.revision) {
      writeLocalRecord(userId, normalizedConversationId, { ...record, dirty: true });
    }
    throw historyError(error);
  }
}
