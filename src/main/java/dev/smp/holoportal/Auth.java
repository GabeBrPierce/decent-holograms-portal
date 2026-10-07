package dev.smp.holoportal;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Password login, in-memory sessions, one-time login links, and a lockout after repeated wrong passwords. */
final class Auth {

    private static final long LINK_MS = 5 * 60_000L;
    private static final long LOCKOUT_MS = 5 * 60_000L;
    private static final int MAX_FAILURES = 5;

    private final byte[] password;
    private final long sessionMs;
    private final SecureRandom random = new SecureRandom();
    private final Map<String, Long> sessions = new ConcurrentHashMap<>();
    private final Map<String, Long> links = new ConcurrentHashMap<>();
    private final Map<String, long[]> failures = new ConcurrentHashMap<>(); // ip -> {count, last failure time}

    Auth(String password, int sessionHours) {
        this.password = password.getBytes(StandardCharsets.UTF_8);
        this.sessionMs = Math.max(1, sessionHours) * 3_600_000L;
    }

    /** Returns a session token, null for a wrong password, or throws when the address is locked out. */
    String login(String ip, String attempt) {
        long now = System.currentTimeMillis();
        long[] f = failures.get(ip);
        if (f != null && f[0] >= MAX_FAILURES && now - f[1] < LOCKOUT_MS) {
            throw new ApiException(429, "Too many wrong passwords. Try again in a few minutes.");
        }
        if (attempt != null && MessageDigest.isEqual(password, attempt.getBytes(StandardCharsets.UTF_8))) {
            failures.remove(ip);
            return newSession();
        }
        failures.compute(ip, (k, v) -> v == null || now - v[1] >= LOCKOUT_MS ? new long[]{1, now} : new long[]{v[0] + 1, now});
        return null;
    }

    String newSession() {
        String token = token();
        sessions.put(token, System.currentTimeMillis() + sessionMs);
        return token;
    }

    boolean valid(String token) {
        if (token == null) return false;
        Long expires = sessions.get(token);
        if (expires == null) return false;
        if (expires < System.currentTimeMillis()) {
            sessions.remove(token);
            return false;
        }
        return true;
    }

    void logout(String token) {
        if (token != null) sessions.remove(token);
    }

    String newLinkToken() {
        long now = System.currentTimeMillis();
        links.values().removeIf(expires -> expires < now);
        String token = token();
        links.put(token, now + LINK_MS);
        return token;
    }

    /** One-time links work once. */
    boolean consumeLink(String token) {
        Long expires = links.remove(token);
        return expires != null && expires >= System.currentTimeMillis();
    }

    private String token() {
        byte[] bytes = new byte[24];
        random.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }
}
