package dev.smp.holoportal;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.logging.Level;

/**
 * The editor's HTTP server (the JDK's built-in one, so no extra dependencies).
 * Serves the single-page app from the jar's web/ folder and a small JSON API under /api.
 */
final class WebServer {

    private static final int MAX_BODY = 1 << 20;
    private static final String COOKIE = "holoportal";
    private static final Map<String, String> TYPES = Map.of(
            "html", "text/html; charset=utf-8",
            "js", "text/javascript; charset=utf-8",
            "css", "text/css; charset=utf-8",
            "svg", "image/svg+xml");
    private static final Gson GSON = new Gson();

    private final HoloPortalPlugin plugin;
    private final Auth auth;
    private final HologramService holograms;
    private final DisplayEditor displays;
    private HttpServer server;
    private ExecutorService pool;

    WebServer(HoloPortalPlugin plugin, Auth auth, HologramService holograms) {
        this.plugin = plugin;
        this.auth = auth;
        this.holograms = holograms;
        this.displays = new DisplayEditor(plugin);
    }

    void start(String bind, int port) throws IOException {
        server = HttpServer.create(new InetSocketAddress(bind, port), 0);
        pool = Executors.newFixedThreadPool(4, r -> {
            Thread t = new Thread(r, "HoloPortal-web");
            t.setDaemon(true);
            return t;
        });
        server.setExecutor(pool);
        server.createContext("/", this::handle);
        server.start();
    }

    void stop() {
        if (server != null) server.stop(0);
        if (pool != null) pool.shutdownNow();
    }

    private void handle(HttpExchange ex) throws IOException {
        try (ex) {
            String method = ex.getRequestMethod();
            String path = ex.getRequestURI().getRawPath();
            ex.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
            ex.getResponseHeaders().set("X-Frame-Options", "DENY");
            ex.getResponseHeaders().set("Referrer-Policy", "no-referrer");
            try {
                if (path.startsWith("/api/")) {
                    api(ex, method, path.substring(5));
                } else if (path.startsWith("/login/") && method.equals("GET")) {
                    linkLogin(ex, path.substring(7));
                } else if (method.equals("GET")) {
                    staticFile(ex, path);
                } else {
                    throw new ApiException(405, "Method not allowed");
                }
            } catch (ApiException e) {
                error(ex, e.status, e.getMessage());
            } catch (Exception e) {
                plugin.getLogger().log(Level.WARNING, "Web editor request failed: " + method + " " + path, e);
                error(ex, 500, "Something went wrong on the server: " + e);
            }
        }
    }

    // ------------------------------------------------------------------ API

    private void api(HttpExchange ex, String method, String route) throws Exception {
        boolean read = method.equals("GET");
        // Browsers won't send a custom header cross-site without a CORS preflight, which this server never approves.
        if (!read && !"1".equals(ex.getRequestHeaders().getFirst("X-HoloPortal"))) throw new ApiException(403, "Missing X-HoloPortal header.");

        if (route.equals("login") && method.equals("POST")) {
            String token = auth.login(ex.getRemoteAddress().getAddress().getHostAddress(), str(body(ex), "password"));
            if (token == null) throw new ApiException(401, "Wrong password.");
            setSession(ex, token);
            json(ex, 200, ok());
            return;
        }
        String session = cookie(ex);
        if (route.equals("session")) {
            JsonObject o = new JsonObject();
            o.addProperty("loggedIn", auth.valid(session));
            json(ex, 200, o);
            return;
        }
        if (!auth.valid(session)) throw new ApiException(401, "Log in first.");
        if (route.equals("logout") && method.equals("POST")) {
            auth.logout(session);
            ex.getResponseHeaders().add("Set-Cookie", COOKIE + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
            json(ex, 200, ok());
            return;
        }

        String[] parts = route.split("/");
        String name = parts.length > 1 ? URLDecoder.decode(parts[1], StandardCharsets.UTF_8) : null;
        switch (parts[0]) {
            case "meta" -> {
                if (read) {
                    JsonObject meta = holograms.meta();
                    meta.add("display", holograms.sync(displays::meta));
                    json(ex, 200, meta);
                    return;
                }
            }
            case "holograms" -> {
                if (name == null && read) { json(ex, 200, holograms.list()); return; }
                if (name == null && method.equals("POST")) {
                    JsonObject b = body(ex);
                    String original = b.has("original") && !b.get("original").isJsonNull() ? b.get("original").getAsString() : null;
                    if (!b.has("hologram") || !b.get("hologram").isJsonObject()) throw new ApiException(400, "Missing hologram.");
                    json(ex, 200, holograms.save(original, nullableStr(b, "fingerprint"), b.getAsJsonObject("hologram")));
                    return;
                }
                if (name != null && parts.length == 2 && read) { json(ex, 200, holograms.get(name)); return; }
                if (name != null && parts.length == 2 && method.equals("DELETE")) { holograms.delete(name); json(ex, 200, ok()); return; }
                if (name != null && parts.length == 3 && parts[2].equals("yaml")) {
                    if (read) {
                        JsonObject o = new JsonObject();
                        o.addProperty("yaml", holograms.yaml(name));
                        json(ex, 200, o);
                        return;
                    }
                    if (method.equals("PUT")) {
                        JsonObject b = body(ex);
                        json(ex, 200, holograms.saveYaml(name, nullableStr(b, "fingerprint"), str(b, "yaml")));
                        return;
                    }
                }
            }
            case "displays" -> {
                if (name == null && read) { json(ex, 200, holograms.sync(displays::list)); return; }
                if (name == null && method.equals("POST")) {
                    JsonObject b = body(ex);
                    String original = nullableStr(b, "original");
                    if (!b.has("display") || !b.get("display").isJsonObject()) throw new ApiException(400, "Missing display.");
                    json(ex, 200, withWarnings(holograms.sync(() -> displays.save(original, nullableStr(b, "fingerprint"), b.getAsJsonObject("display")))));
                    return;
                }
                if (name != null && parts.length == 2 && read) { json(ex, 200, holograms.sync(() -> displays.get(name))); return; }
                if (name != null && parts.length == 2 && method.equals("DELETE")) {
                    holograms.sync(() -> { displays.delete(name); return null; });
                    json(ex, 200, ok());
                    return;
                }
                if (name != null && parts.length == 3 && parts[2].equals("yaml")) {
                    if (read) {
                        JsonObject o = new JsonObject();
                        o.addProperty("yaml", holograms.sync(() -> displays.yaml(name)));
                        json(ex, 200, o);
                        return;
                    }
                    if (method.equals("PUT")) {
                        JsonObject b = body(ex);
                        json(ex, 200, withWarnings(holograms.sync(() -> displays.saveYaml(name, nullableStr(b, "fingerprint"), str(b, "yaml")))));
                        return;
                    }
                }
            }
            case "teleport" -> {
                if (method.equals("POST")) {
                    JsonObject b = body(ex);
                    if ("display".equals(str(b, "kind"))) {
                        holograms.sync(() -> { displays.teleport(str(b, "player"), str(b, "hologram")); return null; });
                    } else {
                        holograms.teleport(str(b, "player"), str(b, "hologram"));
                    }
                    json(ex, 200, ok());
                    return;
                }
            }
            default -> { }
        }
        throw new ApiException(404, "Unknown API route " + method + " /api/" + route);
    }

    private void linkLogin(HttpExchange ex, String token) throws IOException {
        if (auth.consumeLink(token)) setSession(ex, auth.newSession());
        // An expired or used link lands on the login form.
        ex.getResponseHeaders().set("Location", "/");
        ex.sendResponseHeaders(302, -1);
    }

    private void setSession(HttpExchange ex, String token) {
        ex.getResponseHeaders().add("Set-Cookie", COOKIE + "=" + token + "; Path=/; HttpOnly; SameSite=Strict");
    }

    private static String cookie(HttpExchange ex) {
        String header = ex.getRequestHeaders().getFirst("Cookie");
        if (header == null) return null;
        for (String part : header.split(";")) {
            String p = part.trim();
            if (p.startsWith(COOKIE + "=")) return p.substring(COOKIE.length() + 1);
        }
        return null;
    }

    // ------------------------------------------------------------------ static files

    private void staticFile(HttpExchange ex, String path) throws IOException {
        if (path.equals("/")) path = "/index.html";
        if (path.contains("..") || !path.matches("/[a-zA-Z0-9_.-]+")) throw new ApiException(404, "Not found");
        try (InputStream in = plugin.getResource("web" + path)) {
            if (in == null) throw new ApiException(404, "Not found");
            byte[] data = in.readAllBytes();
            String ext = path.substring(path.lastIndexOf('.') + 1);
            ex.getResponseHeaders().set("Content-Type", TYPES.getOrDefault(ext, "application/octet-stream"));
            ex.getResponseHeaders().set("Cache-Control", "no-cache");
            ex.getResponseHeaders().set("Content-Security-Policy",
                    "default-src 'self'; img-src 'self' data: https://mc-heads.net; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
            ex.sendResponseHeaders(200, data.length);
            try (OutputStream out = ex.getResponseBody()) {
                out.write(data);
            }
        }
    }

    // ------------------------------------------------------------------ JSON helpers

    private static JsonObject body(HttpExchange ex) throws IOException {
        byte[] data = ex.getRequestBody().readNBytes(MAX_BODY + 1);
        if (data.length > MAX_BODY) throw new ApiException(413, "Request too large.");
        try {
            JsonElement e = JsonParser.parseString(new String(data, StandardCharsets.UTF_8));
            if (!e.isJsonObject()) throw new ApiException(400, "Expected a JSON object.");
            return e.getAsJsonObject();
        } catch (ApiException e) {
            throw e;
        } catch (Exception e) {
            throw new ApiException(400, "Invalid JSON.");
        }
    }

    private static void json(HttpExchange ex, int status, JsonElement body) throws IOException {
        byte[] data = GSON.toJson(body).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        ex.sendResponseHeaders(status, data.length);
        try (OutputStream out = ex.getResponseBody()) {
            out.write(data);
        }
    }

    private static void error(HttpExchange ex, int status, String message) throws IOException {
        JsonObject o = new JsonObject();
        o.addProperty("error", message);
        json(ex, status, o);
    }

    private static JsonObject withWarnings(DisplayEditor.Result r) {
        JsonObject o = r.display();
        com.google.gson.JsonArray w = new com.google.gson.JsonArray();
        r.warnings().forEach(w::add);
        o.add("warnings", w);
        return o;
    }

    private static JsonObject ok() {
        JsonObject o = new JsonObject();
        o.addProperty("ok", true);
        return o;
    }

    private static String str(JsonObject o, String key) {
        JsonElement e = o.get(key);
        return e == null || e.isJsonNull() ? "" : e.getAsString();
    }

    private static String nullableStr(JsonObject o, String key) {
        JsonElement e = o.get(key);
        return e == null || e.isJsonNull() ? null : e.getAsString();
    }
}
