/**
 * Telegram Messaging MCP Tools
 *
 * Provides tools for AI agents to send messages and photos to Telegram.
 * Chat ID and Topic ID are configured via environment variables, not passed by agent.
 *
 * Environment variables:
 * - JINN_JOB_TELEGRAM_CHAT_ID: Target chat ID (group, channel, or user)
 * - JINN_JOB_TELEGRAM_TOPIC_ID: (Optional) Forum topic/thread ID for supergroups
 */

import { z } from 'zod';
import { getCredential } from '../../shared/credential-client.js';

// ============================================
// Schema Definitions
// ============================================

export const telegramSendMessageParams = z.object({
    text: z.string().min(1).max(4096).describe('Message text to send (max 4096 chars)'),
    parse_mode: z.enum(['HTML', 'Markdown', 'MarkdownV2']).optional()
        .describe('Text formatting mode (optional)'),
    disable_notification: z.boolean().optional()
        .describe('Send silently without notification (optional)'),
});

export const telegramSendMessageSchema = {
    description: `Send a text message to the configured Telegram chat.

FORMATTING (set parse_mode: 'HTML' to enable):
- Bold: <b>text</b>
- Italic: <i>text</i>
- Code: <code>text</code>
- Link: <a href="url">text</a>
- Pre: <pre>block</pre>

Without parse_mode, text is sent as plain (no escaping needed).

Returns: { message_id, chat_id, date } on success`,
    inputSchema: telegramSendMessageParams.shape,
};

export const telegramSendPhotoParams = z.object({
    photo: z.string().min(1).describe('Photo URL or file_id to send'),
    caption: z.string().max(1024).optional().describe('Photo caption (max 1024 chars)'),
    parse_mode: z.enum(['HTML', 'Markdown', 'MarkdownV2']).optional()
        .describe('Caption formatting mode (optional)'),
});

export const telegramSendPhotoSchema = {
    description: `Send a photo to the configured Telegram chat.

Photo can be a URL or file_id from previous upload.

CAPTION FORMATTING (set parse_mode: 'HTML'):
<b>bold</b> <i>italic</i> <code>code</code> <a href="url">link</a>

Returns: { message_id, chat_id, date } on success`,
    inputSchema: telegramSendPhotoParams.shape,
};

export const telegramSendDocumentParams = z.object({
    document: z.string().min(1).describe('Document URL or file_id to send'),
    caption: z.string().max(1024).optional().describe('Document caption (max 1024 chars)'),
    parse_mode: z.enum(['HTML', 'Markdown', 'MarkdownV2']).optional()
        .describe('Caption formatting mode (optional)'),
});

export const telegramSendDocumentSchema = {
    description: `Send a document to the configured Telegram chat.

Document can be a URL or file_id from previous upload.

CAPTION FORMATTING (set parse_mode: 'HTML'):
<b>bold</b> <i>italic</i> <code>code</code> <a href="url">link</a>

Returns: { message_id, chat_id, date } on success`,
    inputSchema: telegramSendDocumentParams.shape,
};

// ============================================
// Helper Functions
// ============================================

async function getTelegramConfig() {
    const botToken = await getCredential('telegram');
    const chatId = process.env.JINN_JOB_TELEGRAM_CHAT_ID;
    const topicIdRaw = process.env.JINN_JOB_TELEGRAM_TOPIC_ID;

    if (!chatId) {
        throw new Error('Missing required environment variable: JINN_JOB_TELEGRAM_CHAT_ID');
    }

    // Parse topic ID as number if provided
    const topicId = topicIdRaw ? parseInt(topicIdRaw, 10) : undefined;

    return { botToken, chatId, topicId };
}

async function telegramApiCall<T>(
    method: string,
    botToken: string,
    params: Record<string, unknown>
): Promise<T> {
    const url = `https://api.telegram.org/bot${botToken}/${method}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
    });

    const data = await response.json() as { ok: boolean; result?: T; description?: string };

    if (!data.ok) {
        throw new Error(`Telegram API error: ${data.description || 'Unknown error'}`);
    }

    return data.result as T;
}

// ============================================
// Tool Implementations
// ============================================

interface TelegramMessage {
    message_id: number;
    chat: { id: number; title?: string; type: string };
    date: number;
    text?: string;
}

export async function telegramSendMessage(args: unknown) {
    try {
        const parsed = telegramSendMessageParams.safeParse(args);
        if (!parsed.success) {
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        data: null,
                        meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
                    }),
                }],
            };
        }

        const config = await getTelegramConfig();
        const { text, parse_mode, disable_notification } = parsed.data;

        const result = await telegramApiCall<TelegramMessage>('sendMessage', config.botToken, {
            chat_id: config.chatId,
            text,
            ...(config.topicId && { message_thread_id: config.topicId }),
            ...(parse_mode && { parse_mode }),
            ...(disable_notification && { disable_notification }),
        });

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    data: {
                        message_id: result.message_id,
                        chat_id: result.chat.id,
                        date: new Date(result.date * 1000).toISOString(),
                    },
                    meta: { ok: true },
                }),
            }],
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    data: null,
                    meta: { ok: false, code: 'EXECUTION_ERROR', message },
                }),
            }],
        };
    }
}

export async function telegramSendPhoto(args: unknown) {
    try {
        const parsed = telegramSendPhotoParams.safeParse(args);
        if (!parsed.success) {
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        data: null,
                        meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
                    }),
                }],
            };
        }

        const config = await getTelegramConfig();
        const { photo, caption, parse_mode } = parsed.data;

        const result = await telegramApiCall<TelegramMessage>('sendPhoto', config.botToken, {
            chat_id: config.chatId,
            photo,
            ...(config.topicId && { message_thread_id: config.topicId }),
            ...(caption && { caption }),
            ...(parse_mode && { parse_mode }),
        });

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    data: {
                        message_id: result.message_id,
                        chat_id: result.chat.id,
                        date: new Date(result.date * 1000).toISOString(),
                    },
                    meta: { ok: true },
                }),
            }],
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    data: null,
                    meta: { ok: false, code: 'EXECUTION_ERROR', message },
                }),
            }],
        };
    }
}

export async function telegramSendDocument(args: unknown) {
    try {
        const parsed = telegramSendDocumentParams.safeParse(args);
        if (!parsed.success) {
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        data: null,
                        meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
                    }),
                }],
            };
        }

        const config = await getTelegramConfig();
        const { document, caption, parse_mode } = parsed.data;

        const result = await telegramApiCall<TelegramMessage>('sendDocument', config.botToken, {
            chat_id: config.chatId,
            document,
            ...(config.topicId && { message_thread_id: config.topicId }),
            ...(caption && { caption }),
            ...(parse_mode && { parse_mode }),
        });

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    data: {
                        message_id: result.message_id,
                        chat_id: result.chat.id,
                        date: new Date(result.date * 1000).toISOString(),
                    },
                    meta: { ok: true },
                }),
            }],
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    data: null,
                    meta: { ok: false, code: 'EXECUTION_ERROR', message },
                }),
            }],
        };
    }
}
