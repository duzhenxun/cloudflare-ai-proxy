import { Hono } from "hono";
import { OpenAI } from "openai";
import { streamSSE } from "hono/streaming";
import { getSupportedModels } from "../constant";
import { createClient } from "../utils";

const openaiRouter = new Hono<{ Bindings: Bindings }>();

// ---------- OpenAI Adapter ----------

openaiRouter.post("/chat/completions", async (c) => {
    try {
        const req = (await c.req.json()) as
            | OpenAI.ChatCompletionCreateParamsNonStreaming
            | OpenAI.ChatCompletionCreateParamsStreaming

        // Map model name to model ID
        const supportedModels = getSupportedModels(c.env);
        const model = supportedModels.find(x => x.name == req.model)
        if (!model) {
            return c.json({
                error: {
                    message: `Model ${req.model} not supported`,
                    type: "invalid_request_error",
                    param: "model",
                    code: "model_not_supported"
                }
            }, 400)
        }
        req.model = model.id;

        const client = createClient(c.env, model);

        if (req.stream) {
            const abortController = new AbortController();

            return streamSSE(c, async (stream: any) => {
                stream.onAbort(() => {
                    abortController.abort();
                });

                const completionStream = await client.chat.completions.create(
                    {
                        ...req,
                        stream: true,
                    },
                    { signal: abortController.signal }
                );

                for await (const chunk of completionStream) {
                    const c = chunk as any;
                    if (c.streamed_data && Array.isArray(c.streamed_data)) {
                        for (const subChunk of c.streamed_data) {
                            await stream.writeSSE({ data: JSON.stringify(subChunk) });
                        }
                    } else {
                        await stream.writeSSE({ data: JSON.stringify(chunk) });
                    }
                }
                await stream.writeSSE({ data: "[DONE]" });
            });
        } else {
            return c.json(await client.chat.completions.create(req));
        }
    } catch (error: any) {
        console.error("Error in /chat/completions:", error);
        // Check if it's an OpenAI API error
        if (error.status && error.error) {
            return c.json(error.error, error.status);
        }
        return c.json({
            error: {
                message: error instanceof Error ? error.message : "Internal server error",
                type: "server_error",
                param: null,
                code: null
            }
        }, 500);
    }
})


openaiRouter.get('/models', async (c) => {
    const supportedModels = getSupportedModels(c.env);
    return c.json({
        object: 'list',
        data: supportedModels.map(model => {
            return {
                id: model.name,
                object: 'model',
                owned_by: 'cloudflare',
                created: Math.floor(Date.now() / 1000),
                owned: true,
            }
        }),
    });
});

export default openaiRouter;
