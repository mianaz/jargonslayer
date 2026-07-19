## Default Permission

Default permissions for the plugin: register_listener/remove_listener only (addPluginListener support for the transcript/status event lanes).

#### This default permission set includes the following:

- `allow-register-listener`
- `allow-remove-listener`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`os-speech:allow-register-listener`

</td>
<td>

Enables the framework-provided register_listener command (addPluginListener) without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`os-speech:deny-register-listener`

</td>
<td>

Denies the framework-provided register_listener command (addPluginListener) without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`os-speech:allow-remove-listener`

</td>
<td>

Enables the framework-provided remove_listener command (PluginListener.unregister) without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`os-speech:deny-remove-listener`

</td>
<td>

Denies the framework-provided remove_listener command (PluginListener.unregister) without any pre-configured scope.

</td>
</tr>
</table>
