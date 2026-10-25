# -*- coding: utf-8 -*-
"""
Markdown → Word(.docx) 转换（给需要打印 / 批注 / 改稿的人用）

支持本项目文档里实际用到的语法：标题（#~####）、分隔线、引用块、表格、
无序 / 有序列表、任务清单、代码块、**加粗**、`行内代码`、[链接](url)。

用法：python tools/md2docx.py <input.md> <output.docx> [标题]
依赖：python-docx（已随文档工具安装）
"""
import re
import sys

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor, Cm

BODY_FONT = '微软雅黑'
CODE_FONT = 'Consolas'
ACCENT = RGBColor(0x0F, 0x9D, 0x58)   # 品牌绿
MUTED = RGBColor(0x64, 0x74, 0x8B)    # 次要灰


# ---------------------------------------------------------------- 样式工具
def set_cn_font(run, name=BODY_FONT, size=None, bold=None, color=None):
    """python-docx 默认只管西文字体，中文字体要单独设 eastAsia。"""
    run.font.name = name
    run._element.rPr.rFonts.set(qn('w:eastAsia'), name)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color is not None:
        run.font.color.rgb = color


def shade(cell, hex_color):
    """给表格单元格加底色。"""
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:fill'), hex_color)
    tc_pr.append(shd)


def add_hr(doc):
    """分隔线用「只有下边框的空段落」实现。"""
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(6)
    p.paragraph_format.space_after = Pt(6)
    p_pr = p._p.get_or_add_pPr()
    border = OxmlElement('w:pBdr')
    bottom = OxmlElement('w:bottom')
    bottom.set(qn('w:val'), 'single')
    bottom.set(qn('w:sz'), '6')
    bottom.set(qn('w:space'), '1')
    bottom.set(qn('w:color'), 'E2E8F0')
    border.append(bottom)
    p_pr.append(border)


INLINE_RE = re.compile(r'(\*\*.+?\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))')


def add_inline(paragraph, text, size=10.5, base_color=None, bold=False):
    """把一行里的 **加粗** / `代码` / [链接](url) 拆成不同样式的 run。"""
    for chunk in INLINE_RE.split(text):
        if not chunk:
            continue
        if chunk.startswith('**') and chunk.endswith('**'):
            run = paragraph.add_run(chunk[2:-2])
            set_cn_font(run, size=size, bold=True, color=base_color)
        elif chunk.startswith('`') and chunk.endswith('`'):
            run = paragraph.add_run(chunk[1:-1])
            set_cn_font(run, name=CODE_FONT, size=size - 0.5, bold=bold, color=RGBColor(0xBE, 0x12, 0x3C))
        elif chunk.startswith('[') and '](' in chunk:
            label, url = chunk[1:-1].split('](', 1)
            run = paragraph.add_run(f'{label}（{url}）')
            set_cn_font(run, size=size, bold=bold, color=RGBColor(0x1D, 0x4E, 0xD8))
        else:
            run = paragraph.add_run(chunk)
            set_cn_font(run, size=size, bold=bold, color=base_color)


# ---------------------------------------------------------------- 主流程
def convert(md_path, docx_path, title=None):
    with open(md_path, encoding='utf-8') as f:
        lines = f.read().split('\n')

    doc = Document()
    # 页面：A4 + 适中页边距
    section = doc.sections[0]
    section.page_width = Cm(21.0)
    section.page_height = Cm(29.7)
    for attr in ('left_margin', 'right_margin'):
        setattr(section, attr, Cm(2.2))
    for attr in ('top_margin', 'bottom_margin'):
        setattr(section, attr, Cm(2.0))

    normal = doc.styles['Normal']
    normal.font.name = BODY_FONT
    normal.font.size = Pt(10.5)
    normal._element.rPr.rFonts.set(qn('w:eastAsia'), BODY_FONT)

    if title:
        p = doc.add_paragraph()
        add_inline(p, title, size=16, bold=True, base_color=ACCENT)
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER

    i, n = 0, len(lines)
    title_done = bool(title)   # 只有首个 H1 当封面标题，后面的一级标题仍走 Heading 1
    while i < n:
        line = lines[i]
        stripped = line.strip()

        # ---- 空行
        if not stripped:
            i += 1
            continue

        # ---- 代码块
        if stripped.startswith('```'):
            i += 1
            code_lines = []
            while i < n and not lines[i].strip().startswith('```'):
                code_lines.append(lines[i])
                i += 1
            i += 1
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.4)
            p.paragraph_format.space_before = Pt(4)
            p.paragraph_format.space_after = Pt(4)
            run = p.add_run('\n'.join(code_lines))
            set_cn_font(run, name=CODE_FONT, size=8.5, color=RGBColor(0x33, 0x41, 0x55))
            shade_paragraph(p, 'F8FAFC')
            continue

        # ---- 分隔线
        if re.fullmatch(r'-{3,}|\*{3,}', stripped):
            add_hr(doc)
            i += 1
            continue

        # ---- 表格
        if stripped.startswith('|') and i + 1 < n and re.match(r'^\|[\s:\-|]+\|$', lines[i + 1].strip()):
            rows = []
            while i < n and lines[i].strip().startswith('|'):
                cells = [c.strip() for c in lines[i].strip().strip('|').split('|')]
                rows.append(cells)
                i += 1
            header, body_rows = rows[0], [r for r in rows[2:]]
            table = doc.add_table(rows=1, cols=len(header))
            table.style = 'Table Grid'
            table.alignment = WD_TABLE_ALIGNMENT.CENTER
            for idx, cell_text in enumerate(header):
                cell = table.rows[0].cells[idx]
                cell.text = ''
                add_inline(cell.paragraphs[0], cell_text, size=9.5, bold=True)
                shade(cell, 'EEF6F1')
            for row in body_rows:
                cells = table.add_row().cells
                for idx, cell_text in enumerate(row[:len(header)]):
                    cells[idx].text = ''
                    add_inline(cells[idx].paragraphs[0], cell_text, size=9.5)
            doc.add_paragraph().paragraph_format.space_after = Pt(2)
            continue

        # ---- 标题
        m = re.match(r'^(#{1,4})\s+(.*)$', stripped)
        if m:
            level, text = len(m.group(1)), m.group(2)
            if level == 1 and not title_done:
                title_done = True
                # 首行当封面标题：居中 + 品牌绿
                p = doc.add_paragraph(style='Title')
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                for run in list(p.runs):
                    run._element.getparent().remove(run._element)
                add_inline(p, text, size=18, bold=True, base_color=ACCENT)
            else:
                # 用内置 Heading 样式，Word 的「导航窗格 / 目录」才能识别层级
                p = doc.add_paragraph(style=f'Heading {min(level, 4)}')
                p.paragraph_format.space_before = Pt(14 if level <= 2 else 10)
                p.paragraph_format.space_after = Pt(6)
                size = {1: 16, 2: 13.5, 3: 12, 4: 11}[level]
                add_inline(p, text, size=size, bold=True,
                           base_color=ACCENT if level <= 2 else RGBColor(0x1F, 0x2A, 0x37))
            i += 1
            continue

        # ---- 引用块（连续 > 行；单独的 > 表示分段）
        if stripped.startswith('>'):
            quote_lines = []
            while i < n and lines[i].strip().startswith('>'):
                quote_lines.append(re.sub(r'^>\s?', '', lines[i].rstrip()))
                i += 1
            for seg in '\n'.join(quote_lines).split('\n'):
                if not seg.strip():
                    continue
                p = doc.add_paragraph()
                p.paragraph_format.left_indent = Cm(0.5)
                p.paragraph_format.space_after = Pt(3)
                add_inline(p, seg.strip(), size=10, base_color=MUTED)
                shade_paragraph(p, 'F8FAFC')
            continue

        # ---- 任务清单 / 无序列表
        m = re.match(r'^([-*])\s+(.*)$', stripped)
        if m:
            text = m.group(2)
            p = doc.add_paragraph(style='List Bullet')
            p.paragraph_format.space_after = Pt(2)
            add_inline(p, text, size=10.5)
            i += 1
            continue

        # ---- 有序列表
        m = re.match(r'^(\d+)\.\s+(.*)$', stripped)
        if m:
            p = doc.add_paragraph(style='List Number')
            p.paragraph_format.space_after = Pt(2)
            add_inline(p, m.group(2), size=10.5)
            i += 1
            continue

        # ---- 普通段落
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.line_spacing = 1.4
        add_inline(p, stripped, size=10.5)
        i += 1

    doc.save(docx_path)
    return docx_path


def shade_paragraph(paragraph, hex_color):
    p_pr = paragraph._p.get_or_add_pPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:fill'), hex_color)
    p_pr.append(shd)


def main():
    if len(sys.argv) < 3:
        print('用法：python tools/md2docx.py <input.md> <output.docx> [标题]')
        return 1
    md_path, docx_path = sys.argv[1], sys.argv[2]
    title = sys.argv[3] if len(sys.argv) > 3 else None
    convert(md_path, docx_path, title)
    print(f'Word 文档已生成：{docx_path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
