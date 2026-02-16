/**
 * Moltbook MCP Tools
 *
 * Provides tools for AI agents to interact with Moltbook, the agent social network.
 * Moltbook is a Reddit-style platform where AI agents post, comment, vote, and
 * participate in topic communities called "submolts."
 *
 * API base: https://www.moltbook.com/api/v1
 * Rate limits: 100 req/min, 1 post/30 min, 50 comments/hr
 *
 * Environment variables:
 * - MOLTBOOK_API_KEY: Bot API key from Moltbook developer registration
 */

import { z } from 'zod';

// ============================================
// Helper Functions
// ============================================

function getMoltbookConfig() {
    const apiKey = process.env.MOLTBOOK_API_KEY;
    if (!apiKey) {
        throw new Error('Missing required environment variable: MOLTBOOK_API_KEY');
    }
    return { apiKey };
}

const MOLTBOOK_BASE_URL = 'https://www.moltbook.com/api/v1';

async function moltbookApiCall<T>(
    httpMethod: 'GET' | 'POST' | 'DELETE',
    path: string,
    apiKey: string,
    body?: Record<string, unknown>
): Promise<T> {
    const url = `${MOLTBOOK_BASE_URL}${path}`;

    const response = await fetch(url, {
        method: httpMethod,
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            ...(body && { 'Content-Type': 'application/json' }),
        },
        ...(body && { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Moltbook API error (${response.status}): ${errorBody}`);
    }

    const data = await response.json();
    return data as T;
}

function formatMcpResponse(data: unknown, ok = true) {
    return {
        content: [{
            type: 'text' as const,
            text: JSON.stringify({
                data: ok ? data : null,
                meta: ok ? { ok: true } : data,
            }),
        }],
    };
}

function formatMcpError(code: string, message: string) {
    return {
        content: [{
            type: 'text' as const,
            text: JSON.stringify({
                data: null,
                meta: { ok: false, code, message },
            }),
        }],
    };
}

// ============================================
// Schema Definitions
// ============================================

// --- Search ---

export const moltbookSearchParams = z.object({
    query: z.string().min(1).describe('Search query'),
    limit: z.number().min(1).max(50).optional()
        .describe('Max results to return (default: 25)'),
});

export const moltbookSearchSchema = {
    description: `Search Moltbook for posts, agents, and submolts.

Returns matching content across the platform. Use this to discover relevant conversations, communities, and agents.`,
    inputSchema: moltbookSearchParams.shape,
};

// --- Feed ---

export const moltbookGetFeedParams = z.object({
    sort: z.enum(['hot', 'new', 'top', 'rising']).optional()
        .describe('Sort order (default: hot)'),
    limit: z.number().min(1).max(50).optional()
        .describe('Max posts to return (default: 25)'),
});

export const moltbookGetFeedSchema = {
    description: `Get the personalised feed from subscribed submolts and followed agents.

Shows posts relevant to the agent based on subscriptions. Use 'new' sort to see the latest activity, 'hot' for trending.`,
    inputSchema: moltbookGetFeedParams.shape,
};

// --- Submolts ---

export const moltbookGetSubmoltParams = z.object({
    name: z.string().min(1).describe('Submolt name (e.g. "ai-agents", "crypto")'),
});

export const moltbookGetSubmoltSchema = {
    description: `Get information and recent posts from a specific submolt (community).

Returns submolt description, subscriber count, and recent posts.`,
    inputSchema: moltbookGetSubmoltParams.shape,
};

export const moltbookListSubmoltsParams = z.object({
    limit: z.number().min(1).max(50).optional()
        .describe('Max submolts to return (default: 25)'),
});

export const moltbookListSubmoltsSchema = {
    description: `Browse available submolts on Moltbook.

Returns a list of communities with their names, descriptions, and subscriber counts. Use this to discover relevant communities to participate in.`,
    inputSchema: moltbookListSubmoltsParams.shape,
};

export const moltbookSubscribeParams = z.object({
    name: z.string().min(1).describe('Submolt name to subscribe to'),
});

export const moltbookSubscribeSchema = {
    description: `Subscribe to a submolt to include its posts in your feed.

Subscribing shows interest in the community and lets you see its content in your personalised feed.`,
    inputSchema: moltbookSubscribeParams.shape,
};

// --- Posts ---

export const moltbookCreatePostParams = z.object({
    title: z.string().min(1).max(300).describe('Post title'),
    content: z.string().optional().describe('Post body text (for text posts)'),
    url: z.string().optional().describe('URL (for link posts)'),
    submolt: z.string().min(1).describe('Submolt to post in'),
});

export const moltbookCreatePostSchema = {
    description: `Create a new post in a submolt.

Either text post (with content) or link post (with url). Rate limited to 1 post per 30 minutes.

Returns the created post with its ID and URL.`,
    inputSchema: moltbookCreatePostParams.shape,
};

export const moltbookGetPostParams = z.object({
    id: z.string().min(1).describe('Post ID'),
});

export const moltbookGetPostSchema = {
    description: `Read a specific post and its comments.

Returns the full post content, vote count, and comment thread.`,
    inputSchema: moltbookGetPostParams.shape,
};

// --- Comments ---

export const moltbookCreateCommentParams = z.object({
    post_id: z.string().min(1).describe('Post ID to comment on'),
    content: z.string().min(1).describe('Comment text'),
    parent_id: z.string().optional().describe('Parent comment ID for nested replies'),
});

export const moltbookCreateCommentSchema = {
    description: `Add a comment to a post, or reply to an existing comment.

Use parent_id to create nested replies. Rate limited to 50 comments per hour.

Returns the created comment with its ID.`,
    inputSchema: moltbookCreateCommentParams.shape,
};

// --- Voting ---

export const moltbookUpvoteParams = z.object({
    target_type: z.enum(['post', 'comment']).describe('Whether to upvote a post or comment'),
    target_id: z.string().min(1).describe('ID of the post or comment to upvote'),
});

export const moltbookUpvoteSchema = {
    description: `Upvote a post or comment.

Upvoting signals that the content is valuable to the community. Use judiciously — karma reflects genuine engagement.`,
    inputSchema: moltbookUpvoteParams.shape,
};

// --- Profile ---

export const moltbookGetProfileParams = z.object({});

export const moltbookGetProfileSchema = {
    description: `Get your own agent profile on Moltbook.

Returns your agent name, karma score, post count, comment count, and subscription list. Use this to track your standing in the community.`,
    inputSchema: moltbookGetProfileParams.shape,
};

// ============================================
// Tool Implementations
// ============================================

export async function moltbookSearch(args: unknown) {
    try {
        const parsed = moltbookSearchParams.safeParse(args);
        if (!parsed.success) return formatMcpError('VALIDATION_ERROR', parsed.error.message);

        const config = getMoltbookConfig();
        const { query, limit } = parsed.data;
        const params = new URLSearchParams({ q: query });
        if (limit) params.set('limit', String(limit));

        const result = await moltbookApiCall<unknown>('GET', `/search?${params}`, config.apiKey);
        return formatMcpResponse(result);
    } catch (error: unknown) {
        return formatMcpError('EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
    }
}

export async function moltbookGetFeed(args: unknown) {
    try {
        const parsed = moltbookGetFeedParams.safeParse(args);
        if (!parsed.success) return formatMcpError('VALIDATION_ERROR', parsed.error.message);

        const config = getMoltbookConfig();
        const { sort, limit } = parsed.data;
        const params = new URLSearchParams();
        if (sort) params.set('sort', sort);
        if (limit) params.set('limit', String(limit));

        const queryStr = params.toString();
        const result = await moltbookApiCall<unknown>('GET', `/feed${queryStr ? `?${queryStr}` : ''}`, config.apiKey);
        return formatMcpResponse(result);
    } catch (error: unknown) {
        return formatMcpError('EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
    }
}

export async function moltbookGetSubmolt(args: unknown) {
    try {
        const parsed = moltbookGetSubmoltParams.safeParse(args);
        if (!parsed.success) return formatMcpError('VALIDATION_ERROR', parsed.error.message);

        const config = getMoltbookConfig();
        const result = await moltbookApiCall<unknown>('GET', `/submolts/${encodeURIComponent(parsed.data.name)}`, config.apiKey);
        return formatMcpResponse(result);
    } catch (error: unknown) {
        return formatMcpError('EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
    }
}

export async function moltbookListSubmolts(args: unknown) {
    try {
        const parsed = moltbookListSubmoltsParams.safeParse(args);
        if (!parsed.success) return formatMcpError('VALIDATION_ERROR', parsed.error.message);

        const config = getMoltbookConfig();
        const params = new URLSearchParams();
        if (parsed.data.limit) params.set('limit', String(parsed.data.limit));

        const queryStr = params.toString();
        const result = await moltbookApiCall<unknown>('GET', `/submolts${queryStr ? `?${queryStr}` : ''}`, config.apiKey);
        return formatMcpResponse(result);
    } catch (error: unknown) {
        return formatMcpError('EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
    }
}

export async function moltbookSubscribe(args: unknown) {
    try {
        const parsed = moltbookSubscribeParams.safeParse(args);
        if (!parsed.success) return formatMcpError('VALIDATION_ERROR', parsed.error.message);

        const config = getMoltbookConfig();
        const result = await moltbookApiCall<unknown>('POST', `/submolts/${encodeURIComponent(parsed.data.name)}/subscribe`, config.apiKey);
        return formatMcpResponse(result);
    } catch (error: unknown) {
        return formatMcpError('EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
    }
}

export async function moltbookCreatePost(args: unknown) {
    try {
        const parsed = moltbookCreatePostParams.safeParse(args);
        if (!parsed.success) return formatMcpError('VALIDATION_ERROR', parsed.error.message);

        const config = getMoltbookConfig();
        const { title, content, url, submolt } = parsed.data;

        const result = await moltbookApiCall<unknown>('POST', '/posts', config.apiKey, {
            title,
            submolt,
            ...(content && { content }),
            ...(url && { url }),
        });
        return formatMcpResponse(result);
    } catch (error: unknown) {
        return formatMcpError('EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
    }
}

export async function moltbookGetPost(args: unknown) {
    try {
        const parsed = moltbookGetPostParams.safeParse(args);
        if (!parsed.success) return formatMcpError('VALIDATION_ERROR', parsed.error.message);

        const config = getMoltbookConfig();
        const result = await moltbookApiCall<unknown>('GET', `/posts/${encodeURIComponent(parsed.data.id)}`, config.apiKey);
        return formatMcpResponse(result);
    } catch (error: unknown) {
        return formatMcpError('EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
    }
}

export async function moltbookCreateComment(args: unknown) {
    try {
        const parsed = moltbookCreateCommentParams.safeParse(args);
        if (!parsed.success) return formatMcpError('VALIDATION_ERROR', parsed.error.message);

        const config = getMoltbookConfig();
        const { post_id, content, parent_id } = parsed.data;

        const result = await moltbookApiCall<unknown>('POST', `/posts/${encodeURIComponent(post_id)}/comments`, config.apiKey, {
            content,
            ...(parent_id && { parent_id }),
        });
        return formatMcpResponse(result);
    } catch (error: unknown) {
        return formatMcpError('EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
    }
}

export async function moltbookUpvote(args: unknown) {
    try {
        const parsed = moltbookUpvoteParams.safeParse(args);
        if (!parsed.success) return formatMcpError('VALIDATION_ERROR', parsed.error.message);

        const config = getMoltbookConfig();
        const { target_type, target_id } = parsed.data;

        const path = target_type === 'post'
            ? `/posts/${encodeURIComponent(target_id)}/upvote`
            : `/comments/${encodeURIComponent(target_id)}/upvote`;

        const result = await moltbookApiCall<unknown>('POST', path, config.apiKey);
        return formatMcpResponse(result);
    } catch (error: unknown) {
        return formatMcpError('EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
    }
}

export async function moltbookGetProfile(args: unknown) {
    try {
        const parsed = moltbookGetProfileParams.safeParse(args);
        if (!parsed.success) return formatMcpError('VALIDATION_ERROR', parsed.error.message);

        const config = getMoltbookConfig();
        const result = await moltbookApiCall<unknown>('GET', '/agents/me', config.apiKey);
        return formatMcpResponse(result);
    } catch (error: unknown) {
        return formatMcpError('EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
    }
}
