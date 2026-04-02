export default async function ({ text }) {
  const words = text.trim().split(/\s+/).filter(Boolean)
  return {
    word_count: words.length,
    char_count: text.length
  }
}
