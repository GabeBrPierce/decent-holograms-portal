package dev.smp.holoportal;

/** An error the web editor shows to the user, with the HTTP status to send. */
final class ApiException extends RuntimeException {
    final int status;

    ApiException(int status, String message) {
        super(message);
        this.status = status;
    }
}
