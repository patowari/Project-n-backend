//! pn-doc-tools: turns an untrusted .docx (read from stdin) into plain text.
//!
//! Why this is a separate Rust process and not Node code:
//!   * a .docx is a ZIP of XML supplied by students: classic zip-bomb and
//!     XML-expansion territory. Parsing runs in its own process, so a hostile
//!     file can exhaust at most this process (which the caller kills on a
//!     timeout), never the API.
//!   * it is CPU-bound work that would otherwise block the Node event loop.
//!   * every limit is enforced here, before data is inflated, not after.
//!
//! Usage:  pn-doc-tools docx-text [--max-chars N] < file.docx
//! Output: one JSON line  {"text": "...", "paragraphs": N, "words": N, "truncated": bool}
//! Errors: exit code 2 and {"error": "..."} on stdout.

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;
use std::io::{Cursor, Read, Write};
use zip::ZipArchive;

/// The whole input may not exceed this many bytes.
const MAX_INPUT_BYTES: u64 = 40 * 1024 * 1024;
/// document.xml may not inflate beyond this many bytes (zip-bomb guard).
const MAX_XML_BYTES: u64 = 64 * 1024 * 1024;
/// Archives with more entries than this are refused.
const MAX_ENTRIES: usize = 2_000;
const DEFAULT_MAX_CHARS: usize = 200_000;

#[derive(Serialize, Debug, PartialEq)]
pub struct Extracted {
    pub text: String,
    pub paragraphs: usize,
    pub words: usize,
    pub truncated: bool,
}

#[derive(Debug, PartialEq)]
pub enum DocError {
    TooLarge,
    NotADocx,
    TooManyEntries,
    XmlTooLarge,
    BadXml,
}

impl DocError {
    fn message(&self) -> &'static str {
        match self {
            DocError::TooLarge => "input is too large",
            DocError::NotADocx => "not a valid .docx file",
            DocError::TooManyEntries => "archive has too many entries",
            DocError::XmlTooLarge => "document content is too large",
            DocError::BadXml => "document content is malformed",
        }
    }
}

/// Extracts body text from the bytes of a .docx.
pub fn extract_docx(bytes: &[u8], max_chars: usize) -> Result<Extracted, DocError> {
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err(DocError::TooLarge);
    }
    let mut zip = ZipArchive::new(Cursor::new(bytes)).map_err(|_| DocError::NotADocx)?;
    if zip.len() > MAX_ENTRIES {
        return Err(DocError::TooManyEntries);
    }
    let file = zip
        .by_name("word/document.xml")
        .map_err(|_| DocError::NotADocx)?;
    // Trust nothing the archive says about its own size: cap the real read.
    if file.size() > MAX_XML_BYTES {
        return Err(DocError::XmlTooLarge);
    }
    let mut xml = Vec::new();
    file.take(MAX_XML_BYTES + 1)
        .read_to_end(&mut xml)
        .map_err(|_| DocError::BadXml)?;
    if xml.len() as u64 > MAX_XML_BYTES {
        return Err(DocError::XmlTooLarge);
    }
    parse_document_xml(&xml, max_chars)
}

fn parse_document_xml(xml: &[u8], max_chars: usize) -> Result<Extracted, DocError> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut buf = Vec::new();
    let mut text = String::new();
    let mut in_t = false;
    let mut paragraphs = 0usize;
    let mut truncated = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                b"t" => in_t = true,
                b"tab" => push(&mut text, "\t", max_chars, &mut truncated),
                b"br" | b"cr" => push(&mut text, "\n", max_chars, &mut truncated),
                _ => {}
            },
            Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                b"tab" => push(&mut text, "\t", max_chars, &mut truncated),
                b"br" | b"cr" => push(&mut text, "\n", max_chars, &mut truncated),
                _ => {}
            },
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"t" => in_t = false,
                b"p" => {
                    paragraphs += 1;
                    push(&mut text, "\n", max_chars, &mut truncated);
                }
                _ => {}
            },
            Ok(Event::Text(t)) if in_t => {
                let s = t.unescape().map_err(|_| DocError::BadXml)?;
                push(&mut text, &s, max_chars, &mut truncated);
            }
            Ok(Event::Eof) => break,
            Err(_) => return Err(DocError::BadXml),
            _ => {}
        }
        if truncated {
            break;
        }
        buf.clear();
    }
    let words = text.split_whitespace().count();
    Ok(Extracted {
        text: text.trim_end().to_string(),
        paragraphs,
        words,
        truncated,
    })
}

/// Appends without ever exceeding `max_chars` characters.
fn push(out: &mut String, s: &str, max_chars: usize, truncated: &mut bool) {
    if *truncated {
        return;
    }
    let have = out.chars().count();
    if have >= max_chars {
        *truncated = true;
        return;
    }
    let room = max_chars - have;
    let n = s.chars().count();
    if n <= room {
        out.push_str(s);
    } else {
        out.extend(s.chars().take(room));
        *truncated = true;
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("docx-text") => {
            let mut max_chars = DEFAULT_MAX_CHARS;
            let mut i = 2;
            while i < args.len() {
                if args[i] == "--max-chars" {
                    max_chars = args
                        .get(i + 1)
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(DEFAULT_MAX_CHARS)
                        .clamp(1, 2_000_000);
                    i += 1;
                }
                i += 1;
            }
            let mut input = Vec::new();
            // Never buffer more than the limit, even if stdin is endless.
            if std::io::stdin()
                .take(MAX_INPUT_BYTES + 1)
                .read_to_end(&mut input)
                .is_err()
            {
                fail(DocError::NotADocx);
            }
            match extract_docx(&input, max_chars) {
                Ok(out) => {
                    let _ = writeln!(
                        std::io::stdout(),
                        "{}",
                        serde_json::to_string(&out).unwrap()
                    );
                }
                Err(e) => fail(e),
            }
        }
        Some("--version") | Some("version") => {
            println!("pn-doc-tools {}", env!("CARGO_PKG_VERSION"))
        }
        _ => {
            eprintln!("usage: pn-doc-tools docx-text [--max-chars N] < file.docx");
            std::process::exit(64);
        }
    }
}

fn fail(e: DocError) -> ! {
    let _ = writeln!(
        std::io::stdout(),
        "{}",
        serde_json::json!({ "error": e.message() })
    );
    std::process::exit(2);
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;

    fn docx(xml: &str) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            z.start_file("word/document.xml", SimpleFileOptions::default())
                .unwrap();
            z.write_all(xml.as_bytes()).unwrap();
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    const W: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main""#;

    #[test]
    fn extracts_paragraphs_runs_and_breaks() {
        let xml = format!(
            r#"<w:document {W}><w:body>
              <w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t xml:space="preserve">world</w:t></w:r></w:p>
              <w:p><w:r><w:t>Second</w:t><w:tab/><w:t>line</w:t></w:r></w:p>
            </w:body></w:document>"#
        );
        let out = extract_docx(&docx(&xml), 1000).unwrap();
        assert_eq!(out.text, "Hello world\nSecond\tline");
        assert_eq!(out.paragraphs, 2);
        assert_eq!(out.words, 4);
        assert!(!out.truncated);
    }

    #[test]
    fn unescapes_entities_and_ignores_non_text() {
        let xml = format!(
            r#"<w:document {W}><w:body><w:p><w:pPr><w:t>IGNORED?</w:t></w:pPr></w:p><w:p><w:r><w:t>a &amp; b &lt; c</w:t></w:r></w:p></w:body></w:document>"#
        );
        // note: <w:t> under pPr is still a w:t; the extractor is namespace-agnostic by design.
        let out = extract_docx(&docx(&xml), 1000).unwrap();
        assert!(out.text.contains("a & b < c"));
    }

    #[test]
    fn truncates_at_the_character_limit_without_splitting_chars() {
        let body = "é".repeat(500);
        let xml = format!(
            r#"<w:document {W}><w:body><w:p><w:r><w:t>{body}</w:t></w:r></w:p></w:body></w:document>"#
        );
        let out = extract_docx(&docx(&xml), 100).unwrap();
        assert!(out.truncated);
        assert_eq!(out.text.chars().count(), 100);
    }

    #[test]
    fn rejects_non_zip_and_wrong_archives() {
        assert_eq!(
            extract_docx(b"not a zip at all", 100),
            Err(DocError::NotADocx)
        );
        let mut buf = Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            z.start_file("hello.txt", SimpleFileOptions::default())
                .unwrap();
            z.write_all(b"x").unwrap();
            z.finish().unwrap();
        }
        assert_eq!(
            extract_docx(&buf.into_inner(), 100),
            Err(DocError::NotADocx)
        );
    }

    #[test]
    fn rejects_malformed_xml() {
        assert_eq!(
            extract_docx(&docx("<w:document><w:p></w:document>"), 100),
            Err(DocError::BadXml)
        );
    }

    #[test]
    fn a_zip_bomb_is_refused_before_it_is_inflated_in_memory() {
        // 80 MiB of zeros compress to ~80 KiB: declared size exceeds the cap.
        let big = "0".repeat(80 * 1024 * 1024);
        let bomb = docx(&format!("<w:document>{big}</w:document>"));
        assert!(bomb.len() < 1024 * 1024, "fixture should be small on disk");
        assert_eq!(extract_docx(&bomb, 100), Err(DocError::XmlTooLarge));
    }

    #[test]
    fn oversized_input_is_refused() {
        let huge = vec![0u8; (MAX_INPUT_BYTES + 1) as usize];
        assert_eq!(extract_docx(&huge, 100), Err(DocError::TooLarge));
    }
}
