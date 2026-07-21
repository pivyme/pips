#[test_only]
module pips_logger::activity_tests {
    use pips_logger::activity::record;
    use std::string::utf8;

    #[test]
    fun record_accepts_the_full_attribution_payload() {
        record(@0xa11ce, utf8(b"range"), utf8(b"play_456"), @0xb0b, utf8(b""));
    }
}
