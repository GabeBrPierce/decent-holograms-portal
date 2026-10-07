package dev.smp.holoportal;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import eu.decentsoftware.holograms.api.DecentHologramsAPI;
import eu.decentsoftware.holograms.display.DisplayModule;
import eu.decentsoftware.holograms.display.DisplayService;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.InvalidConfigurationException;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.Player;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;
import java.util.regex.Pattern;

/**
 * Reads and edits DecentHolograms "displays" (text, item and block display entities).
 * <p>
 * Displays aren't part of DH's public API, so this works on their files: each display is
 * {@code plugins/DecentHolograms/displays/<name>.yml}. A save validates the edit, writes the file
 * and has DH reload its displays. If DH doesn't load the display, the old file is put back.
 * DH's warnings during the reload (e.g. a skipped attribute) are passed back to the editor.
 * All methods run on the server thread (callers go through {@link HologramService#sync}).
 */
final class DisplayEditor {

    private static final Pattern NAME = Pattern.compile("[a-zA-Z0-9_-]+");
    static final List<String> TYPES = List.of("TEXT", "ITEM", "BLOCK");
    static final List<String> BILLBOARD = List.of("CENTER", "VERTICAL", "HORIZONTAL", "FIXED");
    static final List<String> ALIGNMENT = List.of("CENTER", "LEFT", "RIGHT");
    static final List<String> ITEM_DISPLAY = List.of("NONE", "THIRD_PERSON_LEFT_HAND", "THIRD_PERSON_RIGHT_HAND",
            "FIRST_PERSON_LEFT_HAND", "FIRST_PERSON_RIGHT_HAND", "HEAD", "GUI", "GROUND", "FIXED");

    /** Attribute name -> {value type, display types it applies to}. Mirrors DH's attribute definitions. */
    static final Map<String, String[]> ATTRIBUTES = new LinkedHashMap<>();

    static {
        String all = "TEXT,ITEM,BLOCK";
        ATTRIBUTES.put("billboard", new String[]{"billboard_constraints", all});
        ATTRIBUTES.put("scale", new String[]{"vector3f", all});
        ATTRIBUTES.put("translation", new String[]{"vector3f", all});
        ATTRIBUTES.put("yaw", new String[]{"float", all});
        ATTRIBUTES.put("pitch", new String[]{"float", all});
        ATTRIBUTES.put("brightness", new String[]{"brightness", all});
        ATTRIBUTES.put("shadow-radius", new String[]{"float", all});
        ATTRIBUTES.put("shadow-strength", new String[]{"float", all});
        ATTRIBUTES.put("alignment", new String[]{"text_alignment", "TEXT"});
        ATTRIBUTES.put("background-color", new String[]{"rgba", "TEXT"});
        ATTRIBUTES.put("line-width", new String[]{"integer", "TEXT"});
        ATTRIBUTES.put("text-opacity", new String[]{"integer", "TEXT"});
        ATTRIBUTES.put("see-through", new String[]{"boolean", "TEXT"});
        ATTRIBUTES.put("text-shadow", new String[]{"boolean", "TEXT"});
        ATTRIBUTES.put("glow-color", new String[]{"rgba", "ITEM,BLOCK"});
        ATTRIBUTES.put("display-type", new String[]{"item_display_type", "ITEM"});
        ATTRIBUTES.put("enchanted", new String[]{"boolean", "ITEM"});
        ATTRIBUTES.put("leather-color", new String[]{"rgba", "ITEM"});
        ATTRIBUTES.put("skull-texture", new String[]{"string", "ITEM"});
    }

    private final HoloPortalPlugin plugin;

    DisplayEditor(HoloPortalPlugin plugin) {
        this.plugin = plugin;
    }

    boolean available() {
        try {
            return DecentHologramsAPI.get().getDisplayModule() != null;
        } catch (Throwable t) {
            return false; // a DH build without displays
        }
    }

    // ------------------------------------------------------------------ reads

    JsonArray list() {
        JsonArray out = new JsonArray();
        if (!available()) return out;
        Set<String> loaded = service().getRegisteredDisplayNames();
        for (File f : files()) {
            String name = nameOf(f);
            JsonObject o = new JsonObject();
            o.addProperty("name", name);
            o.addProperty("kind", "display");
            YamlConfiguration y = YamlConfiguration.loadConfiguration(f);
            o.addProperty("type", y.getString("type", "?"));
            o.addProperty("world", y.getString("location.world", ""));
            o.addProperty("x", round(y.getDouble("location.x")));
            o.addProperty("y", round(y.getDouble("location.y")));
            o.addProperty("z", round(y.getDouble("location.z")));
            o.addProperty("enabled", y.getBoolean("settings.enabled", true));
            o.addProperty("loaded", loaded.contains(name));
            String preview = switch (y.getString("type", "")) {
                case "TEXT" -> {
                    List<?> pages = y.getList("pages");
                    if (pages != null && !pages.isEmpty() && pages.get(0) instanceof Map<?, ?> page
                            && page.get("lines") instanceof List<?> lines && !lines.isEmpty()) yield String.valueOf(lines.get(0));
                    yield "";
                }
                case "ITEM" -> "Item: " + y.getString("item", "");
                case "BLOCK" -> "Block: " + y.getString("block", "");
                default -> "";
            };
            o.addProperty("preview", preview);
            out.add(o);
        }
        return out;
    }

    JsonObject get(String name) {
        File f = require(name);
        YamlConfiguration y = YamlConfiguration.loadConfiguration(f);
        JsonObject o = toJson(y);
        o.addProperty("name", name);
        o.addProperty("loaded", service().getRegisteredDisplayNames().contains(name));
        o.addProperty("fingerprint", fingerprint(f));
        return o;
    }

    String yaml(String name) throws IOException {
        return Files.readString(require(name).toPath(), StandardCharsets.UTF_8);
    }

    /** What the editor needs to build display forms. */
    JsonObject meta() {
        JsonObject o = new JsonObject();
        o.addProperty("available", available());
        JsonObject attrs = new JsonObject();
        ATTRIBUTES.forEach((k, v) -> {
            JsonObject a = new JsonObject();
            a.addProperty("valueType", v[0]);
            JsonArray types = new JsonArray();
            for (String t : v[1].split(",")) types.add(t);
            a.add("types", types);
            attrs.add(k, a);
        });
        o.add("attributes", attrs);
        o.add("billboard", strings(BILLBOARD));
        o.add("alignment", strings(ALIGNMENT));
        o.add("itemDisplayTypes", strings(ITEM_DISPLAY));
        o.add("blocks", strings(Arrays.stream(Material.values())
                .filter(m -> !m.name().startsWith("LEGACY_") && m.isBlock() && !m.isAir())
                .map(m -> m.name().toLowerCase(Locale.ROOT)).sorted().toList()));
        // Defaults DH applies to new displays (attribute-defaults.yml), by type.
        JsonObject defaults = new JsonObject();
        YamlConfiguration d = YamlConfiguration.loadConfiguration(new File(DecentHologramsAPI.get().getDataFolder(), "attribute-defaults.yml"));
        for (String type : TYPES) {
            JsonObject forType = new JsonObject();
            ConfigurationSection s = d.getConfigurationSection("display." + type);
            if (s != null) {
                for (String key : s.getKeys(false)) {
                    if (!s.getBoolean(key + ".enabled", false) || !ATTRIBUTES.containsKey(key)) continue;
                    JsonObject a = new JsonObject();
                    a.addProperty("value-type", s.getString(key + ".value-type"));
                    a.add("value", toJsonValue(s.get(key + ".value")));
                    forType.add(key, a);
                }
            }
            defaults.add(type, forType);
        }
        o.add("defaults", defaults);
        return o;
    }

    // ------------------------------------------------------------------ writes

    record Result(JsonObject display, List<String> warnings) { }

    Result save(String original, String fingerprint, JsonObject dto) throws IOException {
        if (!available()) throw new ApiException(400, "This DecentHolograms build has no displays.");
        String name = str(dto, "name").trim();
        if (!NAME.matcher(name).matches()) throw new ApiException(400, "Names can only use letters, numbers, _ and -.");
        checkCurrent(original, fingerprint);
        return apply(original, name, yamlFor(dto));
    }

    Result saveYaml(String name, String fingerprint, String yaml) throws IOException {
        checkCurrent(name, fingerprint);
        YamlConfiguration test = new YamlConfiguration();
        try {
            test.loadFromString(yaml);
        } catch (InvalidConfigurationException e) {
            throw new ApiException(400, "That isn't valid YAML: " + firstLine(e.getMessage()));
        }
        return apply(name, name, yaml);
    }

    void delete(String name) {
        require(name);
        if (!service().deleteDisplay(name)) {
            // Not loaded (a file DH rejected): just remove the file.
            try {
                Files.deleteIfExists(file(name).toPath());
            } catch (IOException e) {
                throw new ApiException(500, "Couldn't delete the file: " + e.getMessage());
            }
        }
    }

    void teleport(String playerName, String name) {
        YamlConfiguration y = YamlConfiguration.loadConfiguration(require(name));
        World world = Bukkit.getWorld(y.getString("location.world", ""));
        if (world == null) throw new ApiException(400, "That display's world isn't loaded.");
        Player p = Bukkit.getPlayerExact(playerName);
        if (p == null) throw new ApiException(404, playerName + " isn't online.");
        Location at = new Location(world, y.getDouble("location.x"), y.getDouble("location.y"), y.getDouble("location.z"));
        Location target = at.clone().add(0, 0, 2.5);
        target.setDirection(at.toVector().subtract(target.toVector()));
        p.teleportAsync(target);
    }

    private void checkCurrent(String original, String fingerprint) {
        if (original == null) return;
        File f = file(original);
        if (!f.exists()) throw new ApiException(404, "Display '" + original + "' doesn't exist anymore.");
        if (fingerprint != null && !fingerprint.equals(fingerprint(f))) {
            throw new ApiException(409, "Someone changed '" + original + "' since you opened it (in game or in another tab). Reload it to see their changes.");
        }
    }

    private Result apply(String original, String name, String yaml) throws IOException {
        boolean renamed = original == null || !original.equals(name);
        File target = file(name);
        if (renamed && (target.exists() || service().getDisplay(name) != null)) {
            throw new ApiException(409, "A display called '" + name + "' already exists.");
        }
        File oldFile = original == null ? null : file(original);
        String backup = oldFile != null && oldFile.exists() ? Files.readString(oldFile.toPath(), StandardCharsets.UTF_8) : null;

        target.getParentFile().mkdirs();
        Files.writeString(target.toPath(), yaml, StandardCharsets.UTF_8);
        if (renamed && oldFile != null) Files.deleteIfExists(oldFile.toPath());

        List<String> warnings = reloadCapturing(name);
        if (service().getDisplay(name) == null) {
            // DH didn't load it: undo.
            Files.deleteIfExists(target.toPath());
            if (backup != null) Files.writeString(oldFile.toPath(), backup, StandardCharsets.UTF_8);
            reloadCapturing(name);
            String why = warnings.isEmpty() ? "check the server console" : String.join(" ", warnings);
            throw new ApiException(400, "DecentHolograms couldn't load that display: " + why);
        }
        JsonObject o = get(name);
        return new Result(o, warnings);
    }

    /** Reloads DH's displays and returns the warnings it logged about this display. */
    private List<String> reloadCapturing(String name) {
        List<String> messages = new ArrayList<>();
        Logger logger = DecentHologramsAPI.get().getPlugin().getLogger();
        Handler handler = new Handler() {
            @Override
            public void publish(LogRecord r) {
                if (r.getLevel().intValue() < Level.WARNING.intValue()) return;
                String msg = r.getParameters() == null ? r.getMessage() : String.format(r.getMessage().replaceAll("\\{\\d+}", "%s"), r.getParameters());
                if (r.getThrown() != null && r.getThrown().getMessage() != null) msg += " " + r.getThrown().getMessage();
                if (msg != null && msg.contains(name)) messages.add(msg.trim());
            }

            @Override
            public void flush() { }

            @Override
            public void close() { }
        };
        logger.addHandler(handler);
        try {
            service().reload();
        } finally {
            logger.removeHandler(handler);
        }
        return messages;
    }

    // ------------------------------------------------------------------ conversion

    /** Validates an editor display and builds its file in DH's format. */
    private static String yamlFor(JsonObject dto) {
        String type = str(dto, "type").toUpperCase(Locale.ROOT);
        if (!TYPES.contains(type)) throw new ApiException(400, "Unknown display type " + type);
        JsonObject loc = obj(dto, "location");
        String world = str(loc, "world");
        if (Bukkit.getWorld(world) == null) throw new ApiException(400, "World '" + world + "' isn't loaded.");

        YamlConfiguration y = new YamlConfiguration();
        y.set("type", type);
        y.set("location.world", world);
        y.set("location.x", num(loc, "x", 0));
        y.set("location.y", num(loc, "y", 0));
        y.set("location.z", num(loc, "z", 0));
        y.set("location.yaw", clamp(num(loc, "yaw", 0), -180, 180));
        y.set("location.pitch", clamp(num(loc, "pitch", 0), -90, 90));
        JsonObject settings = obj(dto, "settings");
        y.set("settings.enabled", !settings.has("enabled") || settings.get("enabled").getAsBoolean());
        y.set("settings.display-range", clamp(num(settings, "display-range", 256), 1, 1024));
        y.set("settings.update-interval", (int) clamp(num(settings, "update-interval", 20), 1, 72000));

        Map<String, Object> attributes = new LinkedHashMap<>();
        JsonObject attrs = obj(dto, "attributes");
        for (Map.Entry<String, JsonElement> e : attrs.entrySet()) {
            String key = e.getKey();
            String[] spec = ATTRIBUTES.get(key);
            if (spec == null) throw new ApiException(400, "Unknown attribute " + key);
            if (!Arrays.asList(spec[1].split(",")).contains(type)) continue; // e.g. left over after a type change
            JsonObject a = e.getValue().getAsJsonObject();
            String valueType = str(a, "value-type");
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("value-type", valueType);
            out.put("value", attributeValue(key, spec[0], valueType, a.get("value")));
            attributes.put(key, out);
        }
        y.set("attributes", attributes);

        switch (type) {
            case "TEXT" -> {
                List<String> lines = new ArrayList<>();
                JsonArray arr = dto.has("lines") && dto.get("lines").isJsonArray() ? dto.getAsJsonArray("lines") : new JsonArray();
                for (JsonElement l : arr) lines.add(l.getAsString());
                if (lines.isEmpty()) lines.add("");
                Map<String, Object> page = new LinkedHashMap<>();
                page.put("lines", lines);
                y.set("pages", List.of(page));
            }
            case "ITEM" -> y.set("item", material(str(dto, "item"), false));
            case "BLOCK" -> y.set("block", material(str(dto, "block"), true));
            default -> { }
        }
        return y.saveToString();
    }

    private static Object attributeValue(String key, String expected, String valueType, JsonElement v) {
        boolean color = expected.equals("rgba");
        if (!valueType.equals(expected) && !(color && valueType.equals("chroma"))) {
            throw new ApiException(400, key + " can't be a " + valueType + " value.");
        }
        if (v == null || v.isJsonNull()) throw new ApiException(400, key + " has no value.");
        switch (valueType) {
            case "vector3f" -> {
                JsonObject o = v.getAsJsonObject();
                Map<String, Object> m = new LinkedHashMap<>();
                for (String c : List.of("x", "y", "z")) m.put(c, clamp(num(o, c, key.equals("scale") ? 1 : 0), -1000, 1000));
                return m;
            }
            case "rgba" -> {
                JsonObject o = v.getAsJsonObject();
                Map<String, Object> m = new LinkedHashMap<>();
                for (String c : List.of("red", "green", "blue", "alpha")) m.put(c, (int) clamp(num(o, c, 255), 0, 255));
                return m;
            }
            case "chroma" -> {
                JsonObject o = v.getAsJsonObject();
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("period", (int) clamp(num(o, "period", 100), 1, 100000));
                m.put("alpha", (int) clamp(num(o, "alpha", 255), 0, 255));
                m.put("saturation", (int) clamp(num(o, "saturation", 100), 0, 100));
                m.put("value", (int) clamp(num(o, "value", 100), 0, 100));
                return m;
            }
            case "brightness" -> {
                JsonObject o = v.getAsJsonObject();
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("block-light", (int) clamp(num(o, "block-light", 15), 0, 15));
                m.put("sky-light", (int) clamp(num(o, "sky-light", 15), 0, 15));
                return m;
            }
            case "float" -> {
                double d = v.getAsDouble();
                return switch (key) {
                    case "yaw" -> clamp(d, -180, 180);
                    case "pitch" -> clamp(d, -90, 90);
                    case "shadow-radius" -> clamp(d, 0, 64);
                    case "shadow-strength" -> clamp(d, 0, 100);
                    default -> d;
                };
            }
            case "integer" -> {
                int i = v.getAsInt();
                return key.equals("text-opacity") ? (int) clamp(i, 0, 255) : (int) clamp(i, 1, 10000);
            }
            case "boolean" -> {
                return v.getAsBoolean();
            }
            case "string" -> {
                return v.getAsString();
            }
            case "billboard_constraints" -> {
                return oneOf(key, v.getAsString(), BILLBOARD);
            }
            case "text_alignment" -> {
                return oneOf(key, v.getAsString(), ALIGNMENT);
            }
            case "item_display_type" -> {
                return oneOf(key, v.getAsString(), ITEM_DISPLAY);
            }
            default -> throw new ApiException(400, "Unknown value type " + valueType);
        }
    }

    private static String material(String raw, boolean block) {
        String key = raw.trim().toLowerCase(Locale.ROOT);
        if (key.isEmpty()) throw new ApiException(400, block ? "Pick a block." : "Pick an item.");
        Material m = Material.matchMaterial(key);
        if (m == null || (block ? !m.isBlock() : !m.isItem())) {
            throw new ApiException(400, "'" + raw + "' isn't a valid " + (block ? "block" : "item") + ".");
        }
        return m.getKey().toString(); // e.g. minecraft:diamond, the form DH stores
    }

    private static String oneOf(String key, String value, List<String> allowed) {
        String v = value.toUpperCase(Locale.ROOT);
        if (!allowed.contains(v)) throw new ApiException(400, key + " must be one of " + String.join(", ", allowed));
        return v;
    }

    private static JsonObject toJson(ConfigurationSection s) {
        JsonObject o = new JsonObject();
        for (String key : s.getKeys(false)) o.add(key, toJsonValue(s.get(key)));
        return o;
    }

    private static JsonElement toJsonValue(Object v) {
        if (v == null) return JsonNull.INSTANCE;
        if (v instanceof ConfigurationSection s) return toJson(s);
        if (v instanceof Map<?, ?> m) {
            JsonObject o = new JsonObject();
            m.forEach((k, val) -> o.add(String.valueOf(k), toJsonValue(val)));
            return o;
        }
        if (v instanceof List<?> l) {
            JsonArray a = new JsonArray();
            l.forEach(x -> a.add(toJsonValue(x)));
            return a;
        }
        if (v instanceof Number n) return new JsonPrimitive(n);
        if (v instanceof Boolean b) return new JsonPrimitive(b);
        return new JsonPrimitive(String.valueOf(v));
    }

    // ------------------------------------------------------------------ helpers

    private static DisplayService service() {
        DisplayModule module = DecentHologramsAPI.get().getDisplayModule();
        if (module == null) throw new ApiException(400, "This DecentHolograms build has no displays.");
        return module.getDisplayService();
    }

    private static File folder() {
        return new File(DecentHologramsAPI.get().getDataFolder(), "displays");
    }

    private static File file(String name) {
        if (!NAME.matcher(name).matches()) throw new ApiException(400, "Invalid display name.");
        return new File(folder(), name + ".yml");
    }

    private static File require(String name) {
        File f = file(name);
        if (!f.exists()) throw new ApiException(404, "There's no display called '" + name + "'.");
        return f;
    }

    private static List<File> files() {
        File[] fs = folder().listFiles((d, n) -> n.endsWith(".yml"));
        List<File> list = fs == null ? new ArrayList<>() : new ArrayList<>(Arrays.asList(fs));
        list.sort((a, b) -> a.getName().compareToIgnoreCase(b.getName()));
        return list;
    }

    private static String nameOf(File f) {
        return f.getName().substring(0, f.getName().length() - 4);
    }

    private static String fingerprint(File f) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(f.toPath()));
            return HexFormat.of().formatHex(hash, 0, 12);
        } catch (Exception e) {
            return "";
        }
    }

    private static JsonObject obj(JsonObject o, String key) {
        JsonElement e = o.get(key);
        return e != null && e.isJsonObject() ? e.getAsJsonObject() : new JsonObject();
    }

    private static String str(JsonObject o, String key) {
        JsonElement e = o.get(key);
        return e == null || e.isJsonNull() ? "" : e.getAsString();
    }

    private static double num(JsonObject o, String key, double fallback) {
        JsonElement e = o.get(key);
        if (e == null || e.isJsonNull()) return fallback;
        try {
            double d = e.getAsDouble();
            return Double.isFinite(d) ? d : fallback;
        } catch (Exception ex) {
            throw new ApiException(400, key + " must be a number.");
        }
    }

    private static JsonArray strings(List<String> list) {
        JsonArray a = new JsonArray();
        list.forEach(a::add);
        return a;
    }

    private static double clamp(double v, double min, double max) {
        return Math.max(min, Math.min(max, v));
    }

    private static double round(double v) {
        return Math.round(v * 1000) / 1000.0;
    }

    private static String firstLine(String s) {
        int nl = s.indexOf('\n');
        return nl < 0 ? s : s.substring(0, nl);
    }
}
