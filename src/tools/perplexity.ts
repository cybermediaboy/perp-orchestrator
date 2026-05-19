import { z } from "zod";

export const perplexitySearchSchema = {
  query: z.string().describe("Search query for Perplexity AI"),
  focus: z
    .enum(["finance", "academic", "general"])
    .default("finance")
    .describe("Search focus area"),
};

export async function perplexitySearch(args: {
  query: string;
  focus: "finance" | "academic" | "general";
}): Promise<{ answer: string; citations: string[] }> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    throw new Error("PERPLEXITY_API_KEY not set in environment");
  }

  const systemPrompts: Record<string, string> = {
    finance:
      "You are a quant finance research assistant. Focus on trading strategies, market microstructure, and quantitative analysis.",
    academic:
      "You are an academic research assistant. Provide detailed, well-cited answers from academic sources.",
    general: "You are a helpful research assistant.",
  };

  const response = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "sonar-pro",
      messages: [
        { role: "system", content: systemPrompts[args.focus] },
        { role: "user", content: args.query },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Perplexity API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    citations?: string[];
  };

  const answer = data.choices?.[0]?.message?.content ?? "(no answer)";
  const citations: string[] = data.citations ?? [];

  return { answer, citations };
}
