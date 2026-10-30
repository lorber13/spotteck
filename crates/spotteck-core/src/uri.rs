//! Parsing of the playlist and track references the UI passes around: share links,
//! `spotify:` URIs or bare base62 IDs.

const ID_LEN: usize = 22;

fn is_base62_id(s: &str) -> bool {
    s.len() == ID_LEN && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn id_after(input: &str, kind: &str) -> Option<String> {
    let start = input.find(kind)? + kind.len();
    let rest = input[start..].strip_prefix(['/', ':'])?;
    let id: String = rest.chars().take_while(char::is_ascii_alphanumeric).collect();
    is_base62_id(&id).then_some(id)
}

/// The base62 ID of a playlist given as a share link, a `spotify:playlist:` URI or a bare ID.
pub fn playlist_id_of(input: &str) -> Option<String> {
    let s = input.trim();
    if is_base62_id(s) {
        return Some(s.to_owned());
    }
    id_after(s, "playlist")
}

/// The base62 ID of a track given as a share link, a `spotify:track:` URI or a bare ID.
pub fn track_id_of(input: &str) -> Option<String> {
    let s = input.trim();
    if is_base62_id(s) {
        return Some(s.to_owned());
    }
    id_after(s, "track")
}

pub fn playlist_uri(id: &str) -> String {
    format!("spotify:playlist:{id}")
}

pub fn track_uri(id: &str) -> String {
    format!("spotify:track:{id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "37i9dQZF1DXcBWIGoYBM5M";

    #[test]
    fn parses_links_uris_and_ids() {
        for input in [
            format!("https://open.spotify.com/playlist/{ID}?si=abc"),
            format!("https://open.spotify.com/intl-it/playlist/{ID}"),
            format!("spotify:playlist:{ID}"),
            format!("spotify:user:someone:playlist:{ID}"),
            format!("  {ID} "),
        ] {
            assert_eq!(playlist_id_of(&input).as_deref(), Some(ID), "{input}");
        }
    }

    #[test]
    fn rejects_other_input() {
        for input in ["", "https://open.spotify.com/album/37i9dQZF1DXcBWIGoYBM5M", "spotify:playlist:short", "playlist"]
        {
            assert_eq!(playlist_id_of(input), None, "{input}");
        }
    }

    #[test]
    fn parses_tracks() {
        assert_eq!(track_id_of(&track_uri(ID)).as_deref(), Some(ID));
        assert_eq!(track_id_of(&format!("https://open.spotify.com/track/{ID}")).as_deref(), Some(ID));
        assert_eq!(track_id_of("spotify:playlist:x"), None);
    }
}
