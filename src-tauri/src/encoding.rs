//! Turning file bytes into text: byte-order marks, UTF-16, UTF-8, and a guess among legacy
//! encodings (Windows-1252 from Excel/Notepad, Shift_JIS, GBK...) via Firefox's `chardetng`.

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};

/// UTF-16 without a byte-order mark: text that is mostly ASCII has a zero in every other byte.
fn sniff_utf16(sample: &[u8]) -> Option<&'static Encoding> {
    let pairs = sample.len() / 2;
    if pairs < 2 {
        return None;
    }
    let (mut even, mut odd) = (0, 0);
    for (i, b) in sample[..pairs * 2].iter().enumerate() {
        if *b == 0 {
            if i % 2 == 0 {
                even += 1
            } else {
                odd += 1
            }
        }
    }
    // At least 40% of one side is zero, and at most 5% of the other.
    let mostly = |n: usize| n * 10 >= pairs * 4;
    let rarely = |n: usize| n * 20 <= pairs;
    let enc = if mostly(odd) && rarely(even) {
        UTF_16LE
    } else if mostly(even) && rarely(odd) {
        UTF_16BE
    } else {
        return None;
    };
    // The zero pattern alone can match random binary data, so the result must also read as text:
    // nothing malformed (one allowed: the sample may end inside a surrogate pair) and (almost) no
    // control characters.
    let (text, _) = enc.decode_without_bom_handling(&sample[..pairs * 2]);
    if text.matches('\u{fffd}').count() > 1 {
        return None;
    }
    let control = text
        .chars()
        .filter(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r' | '\u{c}'))
        .count();
    (control * 100 <= text.chars().count()).then_some(enc)
}

/// Valid UTF-8, allowing a character cut off at the end (files over `MAX_BYTES` are truncated).
fn is_utf8(bytes: &[u8]) -> bool {
    match std::str::from_utf8(bytes) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none() && bytes.len() - e.valid_up_to() < 4,
    }
}

/// Decode file bytes to text. `None` means the file looks binary.
/// Order: byte-order mark, UTF-16 by its zero bytes, binary (other zero bytes), valid UTF-8,
/// then a guess among legacy encodings (Windows-1252 for Excel/Notepad exports, Shift_JIS, GBK...).
pub fn decode_text(bytes: &[u8]) -> Option<(String, &'static Encoding)> {
    let head = &bytes[..bytes.len().min(8000)];
    let (encoding, skip) = if let Some((enc, bom_len)) = Encoding::for_bom(bytes) {
        (enc, bom_len)
    } else if let Some(enc) = head.contains(&0).then(|| sniff_utf16(head)).flatten() {
        (enc, 0)
    } else if head.contains(&0) {
        return None;
    } else if is_utf8(bytes) {
        (UTF_8, 0)
    } else {
        let mut detector = chardetng::EncodingDetector::new();
        detector.feed(&bytes[..bytes.len().min(1 << 20)], true);
        (detector.guess(None, true), 0)
    };
    let (text, _) = encoding.decode_without_bom_handling(&bytes[skip..]);
    Some((text.into_owned(), encoding))
}

/// Decode with an encoding the user picked ("Reopen with Encoding"), by WHATWG label ("windows-1251",
/// "shift_jis"...). A byte-order mark is dropped only if it matches. `None` for an unknown label.
pub fn decode_as(bytes: &[u8], label: &str) -> Option<(String, &'static Encoding)> {
    let encoding = Encoding::for_label(label.as_bytes())?;
    let (text, _) = encoding.decode_with_bom_removal(bytes);
    Some((text.into_owned(), encoding))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(text: &str, little_endian: bool) -> Vec<u8> {
        text.encode_utf16()
            .flat_map(|u| {
                if little_endian {
                    u.to_le_bytes()
                } else {
                    u.to_be_bytes()
                }
            })
            .collect()
    }

    fn decoded(bytes: &[u8]) -> (String, &'static str) {
        let (text, enc) = decode_text(bytes).expect("text");
        (text, enc.name())
    }

    #[test]
    fn decodes_utf16_with_and_without_bom() {
        let csv = "name,price\nCafé,€5\n";
        let mut le = vec![0xFF, 0xFE];
        le.extend(utf16(csv, true));
        assert_eq!(decoded(&le), (csv.to_string(), "UTF-16LE"));
        let mut be = vec![0xFE, 0xFF];
        be.extend(utf16(csv, false));
        assert_eq!(decoded(&be), (csv.to_string(), "UTF-16BE"));
        // No BOM: recognized by the zero bytes instead of being called binary.
        assert_eq!(decoded(&utf16(csv, true)), (csv.to_string(), "UTF-16LE"));
        assert_eq!(decoded(&utf16(csv, false)), (csv.to_string(), "UTF-16BE"));
        // The 8000-byte sample ends in the middle of an emoji's surrogate pair.
        let long = format!("{}🙂 tail", "a".repeat(3999));
        assert_eq!(decoded(&utf16(&long, true)), (long.clone(), "UTF-16LE"));
    }

    #[test]
    fn decodes_utf8_and_strips_its_bom() {
        assert_eq!(
            decoded("\u{feff}héllo".as_bytes()),
            ("héllo".to_string(), "UTF-8")
        );
        assert_eq!(
            decoded("plain ascii".as_bytes()),
            ("plain ascii".to_string(), "UTF-8")
        );
        // A multi-byte character cut off by truncation is still UTF-8 (not a legacy guess).
        let cut = &"abc é".as_bytes()[..5];
        assert_eq!(decoded(cut).1, "UTF-8");
    }

    #[test]
    fn guesses_legacy_encodings() {
        // Excel's "CSV (Comma delimited)" on Western Windows.
        let (bytes, _, _) =
            encoding_rs::WINDOWS_1252.encode("Name;Note\nCafé;naïve – “quoted” 5 €\n");
        assert_eq!(
            decoded(&bytes),
            (
                "Name;Note\nCafé;naïve – “quoted” 5 €\n".to_string(),
                "windows-1252"
            )
        );
        let jp = "日本語のテキストファイルです。文字化けしないで表示されるべきです。";
        let (bytes, _, _) = encoding_rs::SHIFT_JIS.encode(jp);
        assert_eq!(decoded(&bytes), (jp.to_string(), "Shift_JIS"));
    }

    #[test]
    fn reopen_with_a_chosen_encoding() {
        let (bytes, _, _) = encoding_rs::WINDOWS_1251.encode("Привет");
        assert_eq!(decode_as(&bytes, "windows-1251").map(|(t, e)| (t, e.name())), Some(("Привет".to_string(), "windows-1251")));
        assert_eq!(decode_as("\u{feff}hi".as_bytes(), "utf-8").map(|(t, _)| t), Some("hi".to_string()));
        assert!(decode_as(b"x", "not-an-encoding").is_none());
    }

    #[test]
    fn short_binary_is_not_mistaken_for_utf16() {
        assert_eq!(decode_text(&[1, 2, 0, 3]), None);
        assert_eq!(
            decode_text(&[
                0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, b'I', b'H'
            ]),
            None
        );
    }
}
