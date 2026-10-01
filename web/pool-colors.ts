const paletteSize = 8;
const normalize = (name: string) => name.trim().toLowerCase();

export function poolTone(category: string, categories: readonly string[]) {
  const target = normalize(category);
  const names = [...new Set([...categories.map(normalize), target])].sort();
  const uses = Array<number>(paletteSize).fill(0);
  for (const name of names) {
    let hash = 0;
    for (const letter of name) hash = (hash * 31 + letter.charCodeAt(0)) >>> 0;
    const preferred = hash % paletteSize;
    const leastUsed = Math.min(...uses);
    let tone = preferred;
    while (uses[tone] !== leastUsed) tone = (tone + 1) % paletteSize;
    uses[tone]++;
    if (name === target) return `category-tone-${tone}`;
  }
  return "category-tone-0";
}
