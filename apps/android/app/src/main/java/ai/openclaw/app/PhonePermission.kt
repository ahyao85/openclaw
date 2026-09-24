package ai.openclaw.app

import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.node.DeviceNotificationListenerService
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

internal enum class PhonePermission(
  val errorCode: String,
) {
  Voice("MIC_PERMISSION_REQUIRED"),
  Camera("CAMERA_PERMISSION_REQUIRED"),
  Location("LOCATION_PERMISSION_REQUIRED"),
  Photos("PHOTOS_PERMISSION_REQUIRED"),
  Contacts("CONTACTS_PERMISSION_REQUIRED"),
  Calendar("CALENDAR_PERMISSION_REQUIRED"),
  Notifications("NOTIFICATIONS_PERMISSION_REQUIRED"),
  NotificationListener("NOTIFICATIONS_PERMISSION_REQUIRED"),
  Motion("MOTION_PERMISSION_REQUIRED"),
  Sms("SMS_PERMISSION_REQUIRED"),
  CallLog("CALL_LOG_PERMISSION_REQUIRED"),
  ;

  val label: String
    get() =
      when (this) {
        Voice -> nativeString("Voice")
        Camera -> nativeString("Camera")
        Location -> nativeString("Location")
        Photos -> nativeString("Photos")
        Contacts -> nativeString("Contacts")
        Calendar -> nativeString("Calendar")
        Notifications -> nativeString("Notifications")
        NotificationListener -> nativeString("Notification listener")
        Motion -> nativeString("Motion")
        Sms -> nativeString("SMS")
        CallLog -> nativeString("Call Log")
      }

  val permissions: List<String>
    get() =
      when (this) {
        Voice -> listOf(Manifest.permission.RECORD_AUDIO)
        Camera -> listOf(Manifest.permission.CAMERA)
        Location -> listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        Photos -> photoReadPermissionsForRequest()
        Contacts -> listOf(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS)
        Calendar -> listOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)
        Notifications -> if (Build.VERSION.SDK_INT >= 33) listOf(Manifest.permission.POST_NOTIFICATIONS) else emptyList()
        NotificationListener -> emptyList()
        Motion -> listOf(Manifest.permission.ACTIVITY_RECOGNITION)
        Sms -> listOf(Manifest.permission.SEND_SMS, Manifest.permission.READ_SMS)
        CallLog -> listOf(Manifest.permission.READ_CALL_LOG)
      }

  fun isGranted(
    context: Context,
    required: List<String> = permissions,
  ): Boolean {
    if (this == NotificationListener) return DeviceNotificationListenerService.isAccessEnabled(context)
    val grants = required.map { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
    return if (this == Location || this == Photos) grants.any { it } else grants.all { it }
  }

  fun isAvailable(context: Context): Boolean =
    when (this) {
      Photos -> {
        SensitiveFeatureConfig.photosEnabled
      }

      Sms -> {
        SensitiveFeatureConfig.smsEnabled && context.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
      }

      CallLog -> {
        SensitiveFeatureConfig.callLogEnabled
      }

      Motion -> {
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_SENSOR_ACCELEROMETER) ||
          context.packageManager.hasSystemFeature(PackageManager.FEATURE_SENSOR_STEP_COUNTER) ||
          context.packageManager.hasSystemFeature(PackageManager.FEATURE_SENSOR_STEP_DETECTOR)
      }

      else -> {
        true
      }
    }
}
