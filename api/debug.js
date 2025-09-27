export default function handler(req, res) {
  res.json({
    hasKey: !!process.env.PINECONE_API_KEY,
    keyLength: process.env.PINECONE_API_KEY
      ? process.env.PINECONE_API_KEY.length
      : 0,
    preview: process.env.PINECONE_API_KEY
      ? process.env.PINECONE_API_KEY.slice(0, 6) + "..."
      : null,
  });
}
