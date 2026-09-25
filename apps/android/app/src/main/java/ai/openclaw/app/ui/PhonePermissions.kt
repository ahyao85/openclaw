package ai.openclaw.app.ui

import ai.openclaw.app.NodeApp
import ai.openclaw.app.PhonePermission
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawListItem
import ai.openclaw.app.ui.design.ClawListPanel
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Sensors
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch

@Composable
internal fun PhonePermissionList(
  requestScope: CoroutineScope,
  permissions: List<PhonePermission> = PhonePermission.entries,
  onPermissionChange: () -> Unit,
  enabledFeatures: Map<PhonePermission, Boolean> = emptyMap(),
  onFeatureChange: (PhonePermission, Boolean) -> Unit = { _, _ -> },
) {
  val context = LocalContext.current
  val requester = (context.applicationContext as NodeApp).permissionRequester
  val lifecycleOwner = LocalLifecycleOwner.current
  val onChange by rememberUpdatedState(onPermissionChange)
  val available = remember(context, permissions) { permissions.filter { it.isAvailable(context) } }

  fun readPermissions() = available.associateWith { it.isGranted(context) to requester.isBlocked(it) }

  var states by remember(context, available, enabledFeatures) { mutableStateOf(readPermissions()) }
  var requesting by remember { mutableStateOf(false) }
  var requestError by remember { mutableStateOf<String?>(null) }

  fun refresh() {
    states = readPermissions()
    onChange()
  }

  DisposableEffect(lifecycleOwner, requester, available) {
    requester.resetPermissionNotifications()
    val observer =
      LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_RESUME) refresh()
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
  }

  requestError?.let { Text(text = it, color = ClawTheme.colors.warning, style = ClawTheme.type.body) }
  ClawListPanel(items = available) { permission ->
    val (granted, blocked) = states.getValue(permission)
    val featureEnabled = enabledFeatures[permission]
    val opensSettings = blocked || permission == PhonePermission.NotificationListener
    val onClick: (() -> Unit)? =
      if (requesting || (granted && featureEnabled == null)) {
        null
      } else {
        {
          if (featureEnabled == true && granted) {
            onFeatureChange(permission, false)
            refresh()
          } else {
            // The screen model retains this user action if Android recreates the UI during its prompt.
            requestScope.launch {
              requesting = true
              requestError = null
              try {
                if (requester.request(permission) && featureEnabled != null) {
                  onFeatureChange(permission, true)
                }
                refresh()
              } catch (_: TimeoutCancellationException) {
                requestError = nativeString("Permission request timed out. Tap to try again.")
                refresh()
              } finally {
                requesting = false
              }
            }
          }
        }
      }
    ClawListItem(
      title = if (permission == PhonePermission.Voice) nativeString("Microphone") else permission.label,
      subtitle = if (blocked) nativeString("Blocked by Android") else permission.description,
      leading = {
        Icon(imageVector = permission.icon, contentDescription = null, modifier = Modifier.size(20.dp), tint = ClawTheme.colors.text)
      },
      trailing = {
        if (featureEnabled != null) {
          Switch(checked = featureEnabled && granted, onCheckedChange = { onClick?.invoke() }, enabled = !requesting)
        } else {
          Text(
            text =
              when {
                granted -> nativeString("Allowed")
                opensSettings -> nativeString("Open settings")
                else -> nativeString("Allow")
              },
            color =
              when {
                granted -> ClawTheme.colors.success
                blocked -> ClawTheme.colors.warning
                else -> ClawTheme.colors.accent
              },
            style = ClawTheme.type.label,
          )
        }
      },
      onClick = onClick,
    )
  }
}

private val PhonePermission.description: String
  get() =
    when (this) {
      PhonePermission.Voice -> nativeString("Transcribe voice prompts")
      PhonePermission.Camera -> nativeString("Capture photos and clips from this phone")
      PhonePermission.Location -> nativeString("Read this phone's location")
      PhonePermission.Photos -> nativeString("Read recent photos and media")
      PhonePermission.Contacts -> nativeString("Find people and contact details")
      PhonePermission.Calendar -> nativeString("Read and update events")
      PhonePermission.Notifications -> nativeString("Show OpenClaw alerts")
      PhonePermission.NotificationListener -> nativeString("Read selected app notifications")
      PhonePermission.Motion -> nativeString("Share steps and activity")
      PhonePermission.Sms -> nativeString("Device access; Gateway opt-in still required")
      PhonePermission.CallLog -> nativeString("Show recent call history")
    }

private val PhonePermission.icon
  get() =
    when (this) {
      PhonePermission.Voice -> Icons.Default.Mic
      PhonePermission.Camera -> Icons.Default.CameraAlt
      PhonePermission.Location -> Icons.Default.LocationOn
      PhonePermission.Photos -> Icons.Default.Image
      PhonePermission.Contacts, PhonePermission.CallLog -> Icons.Default.Person
      PhonePermission.Calendar -> Icons.Default.CalendarMonth
      PhonePermission.Notifications, PhonePermission.Sms -> Icons.Default.Notifications
      PhonePermission.NotificationListener, PhonePermission.Motion -> Icons.Default.Sensors
    }
