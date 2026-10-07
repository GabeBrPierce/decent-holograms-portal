package dev.smp.holoportal;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.List;

public final class HoloPortalPlugin extends JavaPlugin {

    private Auth auth;
    private WebServer web;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        if (getConfig().getString("password", "").isBlank()) {
            getConfig().set("password", randomPassword());
            saveConfig();
            getLogger().info("Generated a web editor password. It's in plugins/HoloPortal/config.yml.");
        }
        start();
    }

    @Override
    public void onDisable() {
        if (web != null) web.stop();
    }

    private void start() {
        auth = new Auth(getConfig().getString("password"), getConfig().getInt("session-hours", 12));
        web = new WebServer(this, auth, new HologramService(this));
        String bind = getConfig().getString("bind", "0.0.0.0");
        int port = getConfig().getInt("port", 8790);
        try {
            web.start(bind, port);
            getLogger().info("Hologram editor running at " + publicUrl());
        } catch (Exception e) {
            getLogger().severe("Couldn't start the web editor on " + bind + ":" + port + ": " + e.getMessage());
            web = null;
        }
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        String sub = args.length == 0 ? "" : args[0].toLowerCase();
        switch (sub) {
            case "link" -> {
                String url = publicUrl() + "/login/" + auth.newLinkToken();
                if (sender instanceof Player) {
                    sender.sendMessage(Component.text("Click to open the hologram editor", NamedTextColor.AQUA)
                            .clickEvent(ClickEvent.openUrl(url))
                            .append(Component.text(" (one use, expires in 5 minutes)", NamedTextColor.GRAY)));
                } else {
                    sender.sendMessage("One-time login link (expires in 5 minutes): " + url);
                }
            }
            case "reload" -> {
                if (web != null) web.stop();
                reloadConfig();
                start();
                sender.sendMessage(Component.text(web != null ? "HoloPortal reloaded." : "HoloPortal failed to start. Check the console.",
                        web != null ? NamedTextColor.GREEN : NamedTextColor.RED));
            }
            default -> {
                if (web == null) {
                    sender.sendMessage(Component.text("The web editor isn't running. Check the console, then /holoportal reload.", NamedTextColor.RED));
                    return true;
                }
                String url = publicUrl();
                sender.sendMessage(Component.text("Hologram editor: ", NamedTextColor.GRAY)
                        .append(Component.text(url, NamedTextColor.AQUA).clickEvent(ClickEvent.openUrl(url))));
                sender.sendMessage(Component.text("Log in with the password in plugins/HoloPortal/config.yml, or use /holoportal link.", NamedTextColor.GRAY));
            }
        }
        return true;
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
        if (args.length == 1) return List.of("link", "reload").stream().filter(s -> s.startsWith(args[0].toLowerCase())).toList();
        return Collections.emptyList();
    }

    String publicUrl() {
        String url = getConfig().getString("public-url", "");
        if (!url.isBlank()) return url.replaceAll("/+$", "");
        return "http://" + lanAddress() + ":" + getConfig().getInt("port", 8790);
    }

    private static String lanAddress() {
        String ip = Bukkit.getIp();
        if (ip != null && !ip.isBlank() && !ip.equals("0.0.0.0")) return ip;
        try {
            for (NetworkInterface nic : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nic.isUp() || nic.isLoopback() || nic.isVirtual()) continue;
                for (InetAddress addr : Collections.list(nic.getInetAddresses())) {
                    if (addr instanceof Inet4Address && addr.isSiteLocalAddress()) return addr.getHostAddress();
                }
            }
        } catch (Exception ignored) {
            // Fall through to localhost.
        }
        return "localhost";
    }

    private static String randomPassword() {
        String chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        SecureRandom random = new SecureRandom();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 16; i++) sb.append(chars.charAt(random.nextInt(chars.length())));
        return sb.toString();
    }
}
