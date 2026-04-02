export default async function ({ text, style = 'markdown' }) {
  if (style === 'plain') {
    return { text: text.replace(/[#*_~`]/g, '') }
  }
  return {
    text: `---\n\n${text}\n\n---`
  }
}
