module pips_logger::activity {
    use std::string::String;
    use sui::event;

    /// Bump this when the event shape changes so indexers can branch safely.
    const VERSION: u8 = 1;

    /// One PIPS play, emitted in the same transaction as Predict's OrderMinted event.
    /// Monetary values intentionally stay in Predict's event, the protocol that owns them.
    public struct Played has copy, drop {
        version: u8,
        player: address,
        game: String,
        play_id: String,
        market: address,
        referrer_id: String,
    }

    /// Pure attribution emit. No state, object inputs, custody, or TxContext.
    public fun record(
        player: address,
        game: String,
        play_id: String,
        market: address,
        referrer_id: String,
    ) {
        event::emit(Played { version: VERSION, player, game, play_id, market, referrer_id });
    }

    #[test]
    fun played_shape_is_stable() {
        let event = Played {
            version: VERSION,
            player: @0xa11ce,
            game: b"lucky".to_string(),
            play_id: b"play_123".to_string(),
            market: @0xb0b,
            referrer_id: b"".to_string(),
        };
        assert!(event.version == 1, 0);
        assert!(event.player == @0xa11ce, 1);
        assert!(event.game == b"lucky".to_string(), 2);
        assert!(event.play_id == b"play_123".to_string(), 3);
        assert!(event.market == @0xb0b, 4);
        assert!(event.referrer_id == b"".to_string(), 5);
    }

    #[test]
    fun record_emits_one_complete_user_event() {
        assert!(event::num_events() == 0, 10);
        record(@0xa11ce, b"range".to_string(), b"play_456".to_string(), @0xb0b, b"".to_string());
        assert!(event::num_events() == 1, 11);
        let mut emitted = event::events_by_type<Played>();
        assert!(vector::length(&emitted) == 1, 12);
        let played = vector::pop_back(&mut emitted);
        assert!(played.version == VERSION, 13);
        assert!(played.player == @0xa11ce, 14);
        assert!(played.game == b"range".to_string(), 15);
        assert!(played.play_id == b"play_456".to_string(), 16);
        assert!(played.market == @0xb0b, 17);
        assert!(played.referrer_id == b"".to_string(), 18);
    }
}
