"""Render the README hero, docs/assets/flow-{dark,light}.svg: one main-chat compaction, native vs ours.

Usage: python3 scripts/readme-hero.py [outdir]   (default docs/assets)
Figures are the README benchmark's main-chat medians.
"""
import random
import sys
from html import escape

THEMES = {
    "dark": dict(bg="#0D1117", title="#F0F6FC", body="#9DA7B3", msg="#3B4452", rule="#30363D",
                 words="#E9B949", ours="#5CC8B8", fork="#F0705A", on_ours="#0D1117"),
    "light": dict(bg="#FFFFFF", title="#1F2328", body="#59636E", msg="#C9D1D9", rule="#D0D7DE",
                  words="#B7791F", ours="#0F766E", fork="#C2410C", on_ours="#FFFFFF"),
}

SANS = "-apple-system, Segoe UI, Helvetica, Arial, sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
W, H, M = 1200, 392, 28
CHAT_X, CHAT_MAX = M, 420          # the 214k chat spans CHAT_MAX px
ARROW_X1, ARROW_X2, AFTER_X = 470, 690, 712
BAR_H = 44


def stripes(t, x, width, y, seed):
    """The chat as message stripes: grey for the work, amber for your messages."""
    rnd, out, cx = random.Random(seed), [], x
    while cx < x + width:
        w = min(rnd.randint(2, 7), x + width - cx)
        colour = t["words"] if rnd.random() < 0.08 else t["msg"]
        out.append(f'<rect x="{cx}" y="{y}" width="{w}" height="{BAR_H}" fill="{colour}"/>')
        cx += w + 1
    return out


def lane(t, y, name, colour, gist, seconds, chat_k, arrow, after, after_label, chat_label, handoff):
    chat_w = round(CHAT_MAX * chat_k / 214)
    by = y + 16
    out = [f'<text x="{M}" y="{y}" font-size="17"><tspan font-weight="700" fill="{colour}">{escape(name)}</tspan>'
           f'<tspan fill="{t["body"]}">  {escape(gist)}</tspan></text>',
           f'<text x="{W - M}" y="{y + 50}" text-anchor="end" font-size="40" font-weight="700" '
           f'font-family="{MONO}" fill="{colour}">{escape(seconds)}</text>']
    work_w = chat_w - (70 if handoff else 0)
    out += stripes(t, CHAT_X, work_w, by, seed=chat_k)
    if handoff:
        hx = CHAT_X + work_w + 2
        out += [f'<rect x="{hx}" y="{by}" width="{chat_w - work_w - 2}" height="{BAR_H}" rx="3" fill="{t["ours"]}"/>',
                f'<text x="{hx + (chat_w - work_w - 2) / 2}" y="{by + 27}" text-anchor="middle" font-size="12" '
                f'font-weight="700" font-family="{MONO}" fill="{t["on_ours"]}">handoff</text>']
    out += [f'<text x="{CHAT_X}" y="{by + BAR_H + 22}" font-size="13" font-family="{MONO}" fill="{t["body"]}">{escape(chat_label)}</text>',
            f'<line x1="{ARROW_X1}" y1="{by + BAR_H / 2}" x2="{ARROW_X2 - 4}" y2="{by + BAR_H / 2}" stroke="{colour}" '
            f'stroke-width="2.5" marker-end="url(#arr-{"o" if handoff else "f"})"/>',
            f'<text x="{(ARROW_X1 + ARROW_X2) / 2}" y="{by + BAR_H / 2 - 10}" text-anchor="middle" font-size="13" '
            f'font-family="{MONO}" fill="{colour}">{escape(arrow)}</text>']
    out += after(by)
    out.append(f'<text x="{AFTER_X}" y="{by + BAR_H + 22}" font-size="13" font-family="{MONO}" fill="{t["body"]}">{escape(after_label)}</text>')
    return out


def render(t):
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" '
           'aria-label="When a chat fills up. Claude Code\'s own compaction: a second run re-reads all 214k tokens and '
           'paraphrases them into a summary, 18.6k left, 55 s. forward-compaction: Claude writes its own handoff at a '
           'clean point and the plugin swaps it in, 0.085 s, no second run, 8.0k left with your words verbatim, 24 s.">',
           '<title>When a chat fills up: native compaction vs forward-compaction</title>',
           '<defs>']
    for key, colour in (("f", t["fork"]), ("o", t["ours"])):
        out.append(f'<marker id="arr-{key}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" '
                   f'orient="auto"><path d="M0 0L10 5L0 10z" fill="{colour}"/></marker>')
    out += [f'<pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
            f'<rect width="7" height="7" fill="{t["fork"]}" opacity="0.25"/>'
            f'<line x1="0" y1="0" x2="0" y2="7" stroke="{t["fork"]}" stroke-width="3"/></pattern>',
            '</defs>',
            f'<rect width="{W}" height="{H}" rx="16" fill="{t["bg"]}"/>',
            f'<g font-family="{SANS}">',
            f'<text x="{M}" y="46" font-size="22" font-weight="700" fill="{t["title"]}">When a chat fills up</text>']

    def native_after(by):
        return [f'<rect x="{AFTER_X}" y="{by}" width="120" height="{BAR_H}" rx="3" fill="url(#hatch)"/>',
                f'<text x="{AFTER_X + 134}" y="{by + 27}" font-size="15" fill="{t["body"]}">a summary, paraphrased</text>']

    def ours_after(by):
        segs, x, out = ((22, t["words"]), (22, t["ours"]), (8, t["msg"])), AFTER_X, []
        for w, colour in segs:
            out.append(f'<rect x="{x}" y="{by}" width="{w}" height="{BAR_H}" fill="{colour}"/>')
            x += w + 2
        out.append(f'<text x="{x + 12}" y="{by + 27}" font-size="15" fill="{t["body"]}">your words + handoff, verbatim</text>')
        return out

    out += lane(t, 104, "Claude Code's own compaction", t["fork"], "forks the chat",
                "55 s", 214, "a second run reads it all", native_after,
                "18.6k tokens left", "the chat, 214k tokens", handoff=False)
    out += lane(t, 236, "forward-compaction", t["ours"], "no fork",
                "24 s", 167, "swapped in, 0.085 s", ours_after,
                "8.0k tokens left", "the chat, 167k tokens", handoff=True)
    ly = H - 30
    out.append(f'<line x1="{M}" y1="{ly - 26}" x2="{W - M}" y2="{ly - 26}" stroke="{t["rule"]}"/>')
    x = M
    for kind, label in (("words", "your words"), ("ours", "written by the Claude that did the work"),
                        ("hatch", "rewritten by a second run")):
        fill = "url(#hatch)" if kind == "hatch" else t[kind]
        out += [f'<rect x="{x}" y="{ly - 12}" width="14" height="14" rx="2" fill="{fill}"/>',
                f'<text x="{x + 22}" y="{ly}" font-size="14" fill="{t["body"]}">{escape(label)}</text>']
        x += 22 + len(label) * 6.9 + 30
    out.append(f'<text x="{W - M}" y="{ly}" text-anchor="end" font-size="13" font-family="{MONO}" fill="{t["body"]}">'
               'main chats · medians of 2,939 real compactions</text>')
    out += ['</g>', '</svg>']
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    outdir = sys.argv[1] if len(sys.argv) > 1 else "docs/assets"
    for name, theme in THEMES.items():
        with open(f"{outdir}/flow-{name}.svg", "w") as f:
            f.write(render(theme))
