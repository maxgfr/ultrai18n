unread-count = { $count ->
    [one] One unread message
   *[other] { $count } unread messages
}
