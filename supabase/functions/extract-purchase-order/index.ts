const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const maxEncodedFileLength = 14 * 1024 * 1024;

const responseSchema = {
  type: 'OBJECT',
  properties: {
    clientName: { type: 'STRING', description: 'The company issuing the PO' },
    poNo: { type: 'STRING', description: 'Purchase Order Number' },
    poDate: { type: 'STRING', description: 'Purchase Order Date' },
    clientAddress: { type: 'STRING', description: 'Delivery or billing address' },
    clientGstin: { type: 'STRING', description: 'GSTIN of the client' },
    clientVendorCode: { type: 'STRING', description: 'Our vendor code with the client' },
    items: {
      type: 'ARRAY',
      description: 'List of line items/products',
      items: {
        type: 'OBJECT',
        properties: {
          description: { type: 'STRING', description: 'Item description or part code' },
          quantity: { type: 'NUMBER', description: 'Quantity' },
          rate: { type: 'NUMBER', description: 'Unit price' },
          per: { type: 'STRING', description: 'Unit of measure e.g. Nos, Pcs' },
          hsn: { type: 'STRING', description: 'HSN Code' },
        },
      },
    },
  },
};

Deno.serve(async request => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405);
  }

  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) {
    return jsonResponse(
      { error: 'Purchase order extraction is not configured. Contact your administrator.' },
      503
    );
  }

  try {
    const body = await request.json();
    const mimeType = body?.mimeType;
    const data = body?.data;
    if (
      !['application/pdf', 'image/jpeg'].includes(mimeType) ||
      typeof data !== 'string' ||
      data.length === 0 ||
      data.length > maxEncodedFileLength ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
    ) {
      return jsonResponse({ error: 'Upload a valid PDF or JPG file under 10 MB.' }, 400);
    }

    const fileType = mimeType === 'application/pdf' ? 'PDF' : 'JPG';
    const geminiResponse = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                text: `You are a data extractor. From this purchase order ${fileType}, extract ONLY the requested fields as compact JSON. Keep string values under 100 characters. Do not include an explanation.`,
              },
              { inline_data: { mime_type: mimeType, data } },
            ],
          }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema,
            maxOutputTokens: 8192,
          },
        }),
      }
    );

    if (!geminiResponse.ok) {
      const upstreamError = await geminiResponse.json().catch(() => null);
      const message = upstreamError?.error?.message;
      return jsonResponse(
        { error: typeof message === 'string' ? message : 'Gemini could not process this document.' },
        502
      );
    }

    const result = await geminiResponse.json();
    const text = result?.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part.text || '')
      .join('');
    if (!text) {
      return jsonResponse({ error: 'Gemini returned no purchase order data.' }, 502);
    }

    let extractedData: unknown;
    try {
      extractedData = JSON.parse(text);
    } catch {
      return jsonResponse({ error: 'Gemini returned invalid purchase order data.' }, 502);
    }

    return jsonResponse({ extractedData }, 200);
  } catch (error) {
    console.error('Purchase order extraction failed:', error);
    return jsonResponse({ error: 'Could not process the purchase order.' }, 500);
  }
});

function jsonResponse(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}
